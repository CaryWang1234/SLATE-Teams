/**
 * SLATE MCP Server 管理组件
 * 在扩展页中展示已配置的外部 MCP Server，支持添加/删除/连接/断开。
 */

import { get, post, del } from "../services/api.js?v=20261017-001";
import { dlgPrompt, dlgConfirm } from "../services/dialog.js?v=20261017-001";
import { refreshSkills } from "./skill_panel.js?v=20261017-001";
import { setExtCount } from "./extensions.js?v=20261017-001";
import { iconSvgEl } from "../services/icons.js?v=20261017-001";
import { mcpIconKey } from "../services/mcp_logos.js?v=20261017-001";
import { state, subscribe } from "../store.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";
import { forgetScopeCatalog } from "../services/project_scope.js?v=20261017-001";

let serverListEl, btnAdd, btnRefresh;

/** 面板的视野＝屏幕上这个项目：掩码只对单个项目有意义，没开项目时这一列控件不出现。 */
function activeProjectId() {
  return String(state.project?.project_id || "");
}

function showToast(msg) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 2200);
}

const STATUS_LABEL = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "未连接",
  error: "错误",
};

function renderServerList(servers) {
  if (!serverListEl) return;
  serverListEl.innerHTML = "";
  setExtCount("mcp", servers?.length || 0);

  if (!servers || !servers.length) {
    const empty = document.createElement("div");
    empty.className = "mcp-server-empty";
    empty.textContent = "尚未配置外部 MCP Server，点「+ 添加 MCP Server」开始连接";
    serverListEl.appendChild(empty);
    return;
  }

  for (const srv of servers) {
    const item = document.createElement("div");
    item.className = "mcp-server-item";

    // 状态指示灯
    const statusDot = document.createElement("span");
    statusDot.className = `mcp-server-status ${srv.status || "disconnected"}`;
    statusDot.title = STATUS_LABEL[srv.status] || srv.status;

    // 品牌 mark 当行首头像；认不出品牌的 Server 一律画 MCP 官方 mark
    const avatar = document.createElement("span");
    avatar.className = "mcp-server-avatar";
    avatar.dataset.mcpIcon = mcpIconKey(srv.name, srv.url); // 走查与排障要能看出匹配到了哪个 mark
    avatar.appendChild(iconSvgEl(avatar.dataset.mcpIcon, "mcp-server-logo"));

    // 信息区
    const info = document.createElement("div");
    info.className = "mcp-server-info";

    const nameRow = document.createElement("div");
    nameRow.className = "mcp-server-name";
    nameRow.appendChild(statusDot); // 状态灯贴着名字：头像只说明"是哪一家"，不说明连没连上
    nameRow.appendChild(document.createTextNode(srv.name || srv.id));
    // 这台在当前项目里到底用不用，取决于掩码还是全局版本——两者关错的代价不同：
    // 关全局会把所有项目共用的服务器停掉，所以这一行必须写在名字旁边。
    if (srv.enableScope === "project") {
      const badge = document.createElement("span");
      badge.className = "mcp-server-scope-badge";
      badge.textContent = srv.effectiveEnabled ? t("本项目单独启用") : t("本项目单独停用");
      badge.title = t("来自项目「{name}」的掩码，只影响该项目", { name: state.project?.name || "" });
      nameRow.appendChild(badge);
    } else if (srv.effectiveEnabled === false) {
      const badge = document.createElement("span");
      badge.className = "mcp-server-scope-badge";
      badge.textContent = t("全局已停用");
      nameRow.appendChild(badge);
    }

    const urlRow = document.createElement("div");
    urlRow.className = "mcp-server-url";
    urlRow.textContent = srv.url;
    urlRow.title = srv.url;

    info.appendChild(nameRow);
    info.appendChild(urlRow);

    // 工具数量
    if (srv.toolCount > 0) {
      const toolsRow = document.createElement("div");
      toolsRow.className = "mcp-server-tools";
      const toolNames = (srv.tools || []).map(t => t.name).join(", ");
      toolsRow.textContent = `${srv.toolCount} 个工具: ${toolNames}`;
      toolsRow.title = toolNames;
      info.appendChild(toolsRow);
    }

    // 错误信息
    if (srv.error) {
      const errRow = document.createElement("div");
      errRow.className = "mcp-server-tools";
      errRow.style.color = "#ef4444";
      errRow.textContent = srv.error;
      info.appendChild(errRow);
    }

    // 操作按钮
    const actions = document.createElement("div");
    actions.className = "mcp-server-actions";

    if (srv.status === "connected") {
      const btnDisconnect = document.createElement("button");
      btnDisconnect.textContent = "断开";
      btnDisconnect.addEventListener("click", () => handleDisconnect(srv.id));
      actions.appendChild(btnDisconnect);
    } else {
      const btnConnect = document.createElement("button");
      btnConnect.textContent = "连接";
      btnConnect.addEventListener("click", () => handleConnect(srv.id));
      actions.appendChild(btnConnect);
    }

    const btnDelete = document.createElement("button");
    btnDelete.className = "danger";
    btnDelete.textContent = "删除";
    btnDelete.addEventListener("click", () => handleRemove(srv.id, srv.name));
    actions.appendChild(btnDelete);

    // 项目掩码：只改"这一项目用不用它"，全局版本配置原样留着（URL 与密钥也绝不进项目目录）
    const scopeBtn = buildProjectMaskButton(srv);
    if (scopeBtn) actions.appendChild(scopeBtn);

    item.appendChild(avatar);
    item.appendChild(info);
    item.appendChild(actions);
    serverListEl.appendChild(item);
  }
}

/**
 * 这一项目在服务器上能做的下一步动作。三种现场各有不同文案，因为"下一步"不等价：
 * 用着 → 停用（写掩码）；项目里已停用 → 摘掉掩码（回到跟全局）；
 * 全局本来就停用 → 单独启用（掩码写回 true，这台在项目里盖过全局版本）。
 * 没打开项目时返回 null：掩码没有归属，这一列不该出现。
 */
function projectMaskIntent(srv) {
  const pid = activeProjectId();
  if (!pid) return null;
  if (srv.effectiveEnabled !== false) {
    return { label: t("在本项目停用"), hint: t("只在当前项目停用，其他项目不受影响"), mask: { enabled: false }, pid };
  }
  if (srv.enableScope === "project") {
    return { label: t("摘掉本项目掩码"), hint: t("摘掉后这台服务器改用全局配置"), mask: null, pid };
  }
  return { label: t("在本项目单独启用"), hint: t("全局为停用，该项目单独启用，不影响其他项目"), mask: { enabled: true }, pid };
}

function buildProjectMaskButton(srv) {
  const intent = projectMaskIntent(srv);
  if (!intent) return null;
  const btn = document.createElement("button");
  btn.className = "mcp-server-scope-toggle";
  btn.textContent = intent.label;
  btn.title = intent.hint;
  btn.addEventListener("click", () => handleProjectMask(srv.id, srv.name, intent));
  return btn;
}

async function handleProjectMask(serverId, name, intent) {
  try {
    const res = await post(`/mcp-servers/${encodeURIComponent(serverId)}/mask`, {
      project: intent.pid,
      enabled: intent.mask?.enabled ?? null,
      tools: null,
    });
    if (res.code !== 0) { showToast(t("设置失败: {msg}", { msg: res.message || t("未知错误") })); return; }
    showToast(intent.mask ? `${name}：${intent.label}` : `${name}：${t("已摘掉本项目掩码，回到跟全局")}`);
    loadServers();
    refreshSkills();
    forgetScopeCatalog(intent.pid);   // 后台那场的工具清单跟着掩码失效
  } catch (e) {
    showToast(t("设置失败: {msg}", { msg: e.message }));
  }
}

async function loadServers() {
  try {
    const pid = activeProjectId();
    const res = await get(`/mcp-servers${pid ? `?project=${encodeURIComponent(pid)}` : ""}`);
    if (res.code === 0) {
      renderServerList(res.data);
    }
  } catch (e) {
    showToast("加载 MCP Server 列表失败" + e.message);
  }
}

async function handleAddServer() {
  const name = await dlgPrompt("MCP Server 名称：", { title: "添加 MCP Server", placeholder: "例如：filesystem" });
  if (!name || !name.trim()) return;

  const url = await dlgPrompt("MCP Server SSE 地址：", {
    title: "添加 MCP Server",
    placeholder: "http://localhost:3000",
  });
  if (!url || !url.trim()) return;

  showToast("正在连接 MCP Server…");
  try {
    const res = await post("/mcp-servers", { name: name.trim(), url: url.trim(), auto_connect: true });
    if (res.code === 0) {
      const data = res.data;
      if (data.status === "connected") {
        showToast(`已连接 ${data.name}，发现 ${data.toolCount} 个工具`);
      } else if (data.status === "error") {
        showToast(`连接失败: ${data.error || "未知错误"}（已保存配置，可稍后重试）`);
      } else {
        showToast(`已添加 ${data.name}`);
      }
      loadServers();
      refreshSkills();
    } else {
      showToast(`添加失败: ${res.message}`);
    }
  } catch (e) {
    showToast(`添加失败: ${e.message}`);
  }
}

async function handleConnect(serverId) {
  showToast("正在连接…");
  try {
    const res = await post(`/mcp-servers/${serverId}/connect`);
    if (res.code === 0) {
      const data = res.data;
      if (data.status === "connected") {
        showToast(`已连接，发现 ${data.toolCount} 个工具`);
      } else {
        showToast(`连接失败: ${data.error || "未知错误"}`);
      }
      loadServers();
      refreshSkills();
    } else {
      showToast(`连接失败: ${res.message}`);
    }
  } catch (e) {
    showToast(`连接失败: ${e.message}`);
  }
}

async function handleDisconnect(serverId) {
  try {
    const res = await post(`/mcp-servers/${serverId}/disconnect`);
    if (res.code === 0) {
      showToast("已断开");
      loadServers();
      refreshSkills();
    }
  } catch (e) {
    showToast(`断开失败: ${e.message}`);
  }
}

async function handleRemove(serverId, name) {
  if (!await dlgConfirm(`确定删除 MCP Server「${name}」？`, { danger: true, okText: "删除" })) return;
  try {
    const res = await del(`/mcp-servers/${serverId}`);
    if (res.code === 0) {
      showToast(`已删除 ${name}`);
      loadServers();
      refreshSkills();
    }
  } catch (e) {
    showToast(`删除失败: ${e.message}`);
  }
}

function initMcpServerPanel() {
  serverListEl = document.getElementById("mcp-server-list");
  btnAdd = document.getElementById("btn-add-mcp-server");
  btnRefresh = document.getElementById("btn-refresh-mcp-servers");

  if (btnAdd) btnAdd.addEventListener("click", handleAddServer);
  if (btnRefresh) btnRefresh.addEventListener("click", () => { loadServers(); refreshSkills(); });
  // 换视野＝换掩码归属：这行的「在本项目停用」标的是哪个项目，全跟着 state.project 走
  subscribe("project", () => loadServers());

  loadServers();
}

export { initMcpServerPanel, loadServers };
