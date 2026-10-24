/**
 * 设置 → 自定义主题：四个源色 + 板块透明度 + 字体（含自行导入）+ 背景图，改一处就整套重算并即时生效。
 *
 * 生效通道只有一条：控件写 setCustomTheme（store），store 通知 customTheme，
 * app.js 那一份订阅调 applyCustomTheme 注入样式。这里不再自己调 apply——
 * 两处各注入一次会打架，还会让"改了什么"和"页面上看到什么"对不上。
 */
import { state, setCustomTheme } from "../store.js?v=20261024-001";
import {
  THEME_FONTS_MAIN, THEME_FONTS_CODE, THEME_PRESETS, MAX_FONT_BYTES,
  uploadBackground, removeBackground, probeBackground,
  probeWallpaperEngine, pullWallpaperEngineBackground,
  uploadFont, removeFont, probeFonts,
} from "../services/theme_custom.js?v=20261024-001";
import { dlgToast } from "../services/dialog.js?v=20261024-001";
import { t } from "../services/i18n.js?v=20261024-001";
import { reportError } from "../services/error_sink.js?v=20261024-001";

// 背景图上限与后端 theme.py 的 MAX_BACKGROUND_BYTES 同一个数
const MAX_BG_BYTES = 4 * 1024 * 1024;

const COLOR_FIELDS = [
  { key: "bg", id: "theme-color-bg", label: "页面底色" },
  { key: "panel", id: "theme-color-panel", label: "面板底色" },
  { key: "text", id: "theme-color-text", label: "正文颜色" },
  { key: "accent", id: "theme-color-accent", label: "强调颜色" },
];

function el(id) {
  return document.getElementById(id);
}

function fillSelect(select, list) {
  if (!select) return;
  select.innerHTML = "";
  for (const item of list) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.id ? t(item.label) : t("跟随系统");
    select.appendChild(opt);
  }
}

// 下拉的选项只在初始化、导入、移除时建：每次改色都重建一遍会把刚选完的字体框的焦点弄丢
function importedFonts(theme) {
  const list = theme?.fonts?.imported;
  return Array.isArray(list) ? list : [];
}

// 导入的字体排在系统字体后面：常用项的位置不该因为用户导了一个文件就跳
function optionsFor(list, theme) {
  return [...list, ...importedFonts(theme).map(item => ({ id: item.id, label: item.label }))];
}

function syncFontOptions() {
  fillSelect(el("theme-font-main"), optionsFor(THEME_FONTS_MAIN, state.customTheme));
  fillSelect(el("theme-font-code"), optionsFor(THEME_FONTS_CODE, state.customTheme));
  renderThemeSettings();
}

function buildPresets() {
  const row = el("theme-preset-row");
  if (!row) return;
  row.innerHTML = "";
  for (const preset of THEME_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-preset-btn";
    btn.dataset.preset = preset.id;
    btn.title = t(preset.name);
    // 色块取的是预设自己的源色，不是界面配色：这里是"给用户看这张色板长什么样"，
    // 用 var() 反而每个预设都长成同一个颜色。
    for (const key of ["bg", "panel", "text", "accent"]) {
      const chip = document.createElement("span");
      chip.className = "theme-preset-chip";
      chip.style.backgroundColor = preset.colors[key];
      btn.appendChild(chip);
    }
    const name = document.createElement("span");
    name.className = "theme-preset-name";
    name.textContent = t(preset.name);
    btn.appendChild(name);
    btn.addEventListener("click", () => {
      setCustomTheme({ preset: preset.id, colors: { ...preset.colors }, fonts: { ...preset.fonts } });
    });
    row.appendChild(btn);
  }
}

/** 背景图那一行的说明文字：图在不在本机、多大 */
async function renderBgState() {
  const hint = el("theme-bg-state");
  const bgOn = el("theme-bg-enabled");
  const info = await probeBackground();
  if (hint) {
    hint.textContent = info.exists
      ? t("背景图已存在本机（{size}）", { size: `${Math.round((info.bytes || 0) / 1024)} KB` })
      : t("本机还没有背景图");
  }
  // 没有图就别让勾"使用背景图"：勾了也只能得到一层半透明底色压在空屏上
  if (bgOn) bgOn.disabled = !info.exists;
  return info;
}

/** 字体那一行：导入清单 + 每一个在本机还在不在 + 多大 */
async function renderFontState() {
  const box = el("theme-font-list");
  const hint = el("theme-font-state");
  const imported = importedFonts(state.customTheme);
  // 一个都没导入时不发请求：这份清单只有导过字体的机器用得上
  const index = imported.length ? await probeFonts() : null;
  if (box) {
    box.innerHTML = "";
    for (const item of imported) {
      const row = document.createElement("div");
      row.className = "theme-font-item";
      const name = document.createElement("span");
      name.className = "theme-font-name";
      name.textContent = item.label || item.id;
      const meta = document.createElement("span");
      meta.className = "theme-font-meta";
      const onDisk = index && index.ids.has(item.id);
      const bytes = index ? index.sizes.get(item.id) || 0 : 0;
      meta.textContent = !onDisk
        ? t("本机没有这个文件")
        : (bytes ? t("在本机 · {size}", { size: `${Math.round(bytes / 1024)} KB` }) : t("在本机"));
      row.appendChild(name);
      row.appendChild(meta);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-font-remove";
      btn.textContent = t("移除");
      btn.addEventListener("click", () => handleRemoveFont(item.id));
      row.appendChild(btn);
      box.appendChild(row);
    }
  }
  if (hint) {
    if (!imported.length) hint.textContent = t("本机还没有导入的字体");
    else if (!index) hint.textContent = t("无法读取字体清单：后端未运行，或本机尚未导入字体");
    else hint.textContent = t("已导入 {n} 个，在上面的下拉里选用它", { n: imported.length });
  }
  syncFontOptions();
}

async function handleRemoveFont(id) {
  try {
    await removeFont(id);
  } catch (e) {
    reportError(e, "theme_font_remove");
    dlgToast(t("字体移除失败，它可能正被界面占用"));
    return;
  }
  const patch = { imported: importedFonts(state.customTheme).filter(item => item?.id !== id) };
  // 正在用的那一格要一起清掉：留着家庭名，指向的却是已经不存在的文件
  if (state.customTheme?.fonts?.main === id) patch.main = "";
  if (state.customTheme?.fonts?.code === id) patch.code = "";
  setCustomTheme({ fonts: patch });
  dlgToast(t("字体已移除"));
  await renderFontState();
}

async function handlePickFont(file) {
  if (!file) return;
  const picker = el("theme-font-file");
  if (file.size > MAX_FONT_BYTES) {
    dlgToast(t("字体文件不能超过 16MB，请更换更小的文件"));
    if (picker) picker.value = "";
    return;
  }
  try {
    const got = await uploadFont(file);
    const cur = importedFonts(state.customTheme);
    // 同一个文件第二次导入：后端给的是同一个 id，账上就不该出现第二行
    if (!cur.some(item => item?.id === got.id)) {
      setCustomTheme({ fonts: { imported: [...cur, { id: got.id, label: got.label }] } });
    }
    dlgToast(t("字体已导入：{name}", { name: got.label }));
  } catch (e) {
    reportError(e, "theme_font_upload");
    dlgToast(t("字体导入失败：请换单个 .woff2 / .woff / .ttf / .otf"));
  }
  // 清空 value：同一个文件第二次选也要能触发 change
  if (picker) picker.value = "";
  await renderFontState();
}

/** Wallpaper Engine 那一行：装没装、当前哪块屏有可取的预览图 */
async function renderWeState() {
  const hint = el("theme-we-state");
  const btn = el("theme-we-pick");
  const info = await probeWallpaperEngine();
  const hit = info.monitors.find(m => m && m.preview);
  // 没得取就把按钮按下去：让用户点一次才知道"点了没用"是最差的说明
  if (btn) btn.disabled = !hit;
  if (hint) {
    if (!info.installed) {
      hint.textContent = info.reason === "not_windows"
        ? t("Wallpaper Engine 只有 Windows 版，这个入口在别的系统上不会亮")
        : info.reason === "unreachable"
          ? t("问不到后端：Wallpaper Engine 的状态要后端起来了才知道")
          : t("这台机器上没找到 Wallpaper Engine");
    } else if (!info.monitors.length) {
      hint.textContent = t("找到了 Wallpaper Engine，但它现在没有选中的壁纸");
    } else if (!hit) {
      hint.textContent = t("壁纸目录里没有可取的预览图（没有 preview 图，或它超过 4MB）");
    } else {
      const name = String(hit.wallpaper || "").slice(0, 60);
      const size = `${Math.round(Number(hit.preview?.bytes || 0) / 1024)} KB`;
      hint.textContent = name
        ? t("当前壁纸：{name}（预览 {size}）", { name, size })
        : t("有可取的壁纸预览（{size}）", { size });
    }
  }
  return info;
}

async function handlePullWallpaperEngine() {
  const btn = el("theme-we-pick");
  if (btn) btn.disabled = true;
  try {
    const got = await pullWallpaperEngineBackground();
    // 取回来就顺手铺上：与用户自己挑一张图是同一件事，不该还要再去勾一遍
    setCustomTheme({ background: { enabled: true } });
    dlgToast(t("已取用 Wallpaper Engine 当前壁纸（屏幕 {n}）", { n: got.monitor || "1" }));
  } catch (e) {
    reportError(e, "theme_we_pull");
    dlgToast(t("取 Wallpaper Engine 壁纸失败：预览图可能无法读取，或正被 Wallpaper Engine 重写"));
  }
  await renderBgState();
  await renderWeState();
}

export function renderThemeSettings() {
  const theme = state.customTheme;
  if (!theme) return;
  const box = el("theme-custom-enabled");
  if (box) box.checked = theme.enabled === true;
  for (const field of COLOR_FIELDS) {
    const input = el(field.id);
    // 只在值真的变了时才写：正在拖的取色器被反向写一次值，手感会立刻断掉
    if (input && input.value !== theme.colors[field.key]) input.value = theme.colors[field.key];
  }
  const fontMain = el("theme-font-main");
  if (fontMain && fontMain.value !== theme.fonts.main) fontMain.value = theme.fonts.main || "";
  const fontCode = el("theme-font-code");
  if (fontCode && fontCode.value !== theme.fonts.code) fontCode.value = theme.fonts.code || "";
  const alpha = el("theme-panel-alpha");
  if (alpha && alpha.value !== String(theme.opacity.panel)) alpha.value = String(theme.opacity.panel);
  const alphaValue = el("theme-panel-alpha-value");
  if (alphaValue) alphaValue.textContent = `${theme.opacity.panel}%`;
  const bgOn = el("theme-bg-enabled");
  if (bgOn) bgOn.checked = theme.background.enabled === true;
  const veil = el("theme-bg-veil");
  if (veil) veil.value = String(theme.background.veil);
  const veilValue = el("theme-bg-veil-value");
  if (veilValue) veilValue.textContent = `${theme.background.veil}%`;
  for (const btn of [...document.querySelectorAll(".theme-preset-btn")]) {
    btn.classList.toggle("is-active", btn.dataset.preset === theme.preset);
  }
}

async function handlePick(file) {
  if (!file) return;
  if (file.size > MAX_BG_BYTES) {
    dlgToast(t("背景图不能超过 4MB，请更换更小的图片"));
    return;
  }
  const picker = el("theme-bg-file");
  try {
    await uploadBackground(file);
    // 换图顺手把"使用背景图"打开：刚挑了一张图却说没开，比直接拒收更难解释
    setCustomTheme({ background: { enabled: true } });
    dlgToast(t("背景图已换"));
  } catch (e) {
    reportError(e, "theme_background_upload");
    dlgToast(t("背景图上传失败，请更换后重试"));
  }
  // 清空 value：同一张图第二次选也要能触发 change
  if (picker) picker.value = "";
  await renderBgState();
}

export function initThemeSettings() {
  buildPresets();
  syncFontOptions();
  renderThemeSettings();
  renderBgState();
  renderFontState();
  renderWeState();
  const box = el("theme-custom-enabled");

  el("theme-custom-enabled")?.addEventListener("change", (e) => {
    const on = e.target.checked === true;
    setCustomTheme({ enabled: on });
    if (on) dlgToast(t("自定义主题已开启：深色/浅色切换暂时锁定"));
  });
  for (const field of COLOR_FIELDS) {
    el(field.id)?.addEventListener("input", (e) => {
      // 手改色板就把预设标记清掉：这时看到的颜色不再属于任何一个预设
      setCustomTheme({ preset: "", colors: { [field.key]: e.target.value } });
    });
  }
  el("theme-font-main")?.addEventListener("change", (e) => {
    setCustomTheme({ fonts: { main: e.target.value } });
  });
  el("theme-font-code")?.addEventListener("change", (e) => {
    setCustomTheme({ fonts: { code: e.target.value } });
  });
  el("theme-bg-enabled")?.addEventListener("change", (e) => {
    setCustomTheme({ background: { enabled: e.target.checked === true } });
  });
  el("theme-bg-pick")?.addEventListener("click", () => el("theme-bg-file")?.click());
  el("theme-bg-file")?.addEventListener("change", (e) => handlePick(e.target.files?.[0]));
  el("theme-bg-clear")?.addEventListener("click", async () => {
    try {
      await removeBackground();
      setCustomTheme({ background: { enabled: false } });
      dlgToast(t("背景图已移除"));
    } catch (e) {
      reportError(e, "theme_background_remove");
      dlgToast(t("背景图移除失败"));
    }
    await renderBgState();
  });
  el("theme-bg-veil")?.addEventListener("input", (e) => {
    const value = parseInt(e.target.value, 10);
    setCustomTheme({ background: { veil: Number.isFinite(value) ? value : 72 } });
  });
  el("theme-we-pick")?.addEventListener("click", () => handlePullWallpaperEngine());
  // 中途才装好或才启动 WE 的人不该被要求重启应用：这行状态可以再问一次
  el("theme-we-refresh")?.addEventListener("click", () => renderWeState());
  el("theme-panel-alpha")?.addEventListener("input", (e) => {
    const value = parseInt(e.target.value, 10);
    // 100 = 实色：滑块拖到底时不留 rgba(…, 1) 那种"半透明的实色"，令牌与旧行为逐字节相同
    setCustomTheme({ opacity: { panel: Number.isFinite(value) ? value : 100 } });
  });
  el("theme-font-pick")?.addEventListener("click", () => el("theme-font-file")?.click());
  el("theme-font-file")?.addEventListener("change", (e) => handlePickFont(e.target.files?.[0]));
  el("theme-reset")?.addEventListener("click", () => {
    const paper = THEME_PRESETS[0];
    setCustomTheme({ preset: "", colors: { ...paper.colors }, fonts: { main: "", code: "" }, background: { enabled: false } });
    dlgToast(t("已恢复默认色板"));
  });
}
