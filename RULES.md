# SLATE Teams 开发规则（RULES）

> 本文档面向 AI Agent 与人类贡献者，是本项目**当前真实状态**的开发约定。

---

## 1\. 项目定位

* **SLATE Teams**：本地 AI 协作调度台。FastAPI 后端 + 原生 JS 前端 + PyWebView 桌面壳。
* 核心能力：多模型对话、AI 团队辩论与工作流（DAG）、白板逻辑链、提示词工厂、MCP 工具 / SKILL.md 技能、知识库（knowledge）、定时任务、Harness 自主执行、磨墨模式（Grind）、专家包（Expert Pack）、高危命令审批、项目理解三档扫描、国际化（中/英双语）。
* 本地优先：所有数据存本地（SQLite / JSON），API Key 只保存在前端 localStorage 与本地 `desktop_state.json`，不经任何第三方服务器。
* 国际化：安装时 Inno Setup 选语言 → `data/language.txt`（zh/en）→ 后端 `GET /api/i18n/lang` → 前端 `i18n.js` 引擎翻译。详见 §6.4。

## 2\. 绝对红线

1. **禁止 npm / Node.js / 任何构建工具**：前端必须是原生 HTML + CSS + JavaScript（ES Modules，零构建、零打包、零包管理）。
2. **禁止新增依赖**：后端依赖以 `requirements.txt` 为准（fastapi / uvicorn / httpx / python-multipart 等），确需新依赖必须先与用户确认。
3. **禁止代码编辑器组件**：不引入 Monaco / Ace / CodeMirror 等；代码展示只用 `<pre><code>` + Highlight.js（CDN）。
4. **禁止破坏 UI 基调**：本产品的基调是「席 · Ledger」——石墨纸面 + 红墨强调（见 §8），不得引入蓝紫渐变、毛玻璃、大圆角，也不得把强调色改回原作的暖纸金。
5. **禁止原生 alert/confirm/prompt**：所有弹窗统一使用 `dialog.js` 的应用内弹窗（详见 §6.5）。
6. **改动不要同步到其它项目**：所有开发仅在 SLATE Teams 仓库进行。
7. **密钥不落任何可提交路径**：模型 Key 只存 `data/desktop_state.json`（已 gitignore）。`git add -A` 之前先看 `git status`——历史上 `85fa8f6f` 那份已经公开在上游 SLATE（该仓 secret scanning 关着，所以没告警），属既成事实：不得再把它或含它的历史复制进别的仓库或发布线。

## 3\. 技术栈（固定）

|层级|选型|说明|
|-|-|-|
|前端|原生 HTML + CSS + JS（ES Modules）|零构建；CDN 引入 Highlight.js、Mermaid.js|
|后端|Python 3.13+ / FastAPI / Uvicorn|异步轻量服务，入口 `backend/main.py`|
|存储|SQLite（chat\_history.db / knowledge.db）+ JSON|全部位于 data 目录|
|桌面|PyWebView（EdgeChromium）+ PyInstaller|入口 `desktop.py`，规格 `SLATE_Teams.spec`|
| 安装包 | Inno Setup 7 | `SLATE_Teams.iss` + `build_installer.bat`；含语言选择页 |

## 4\. 目录结构（当前）

```
SLATE-Teams/
├── backend/
│   ├── main.py                # FastAPI 入口：注册全部 15 个路由、挂载 frontend 静态目录
│   ├── routers/               # 路由层（proxy/constitution/skills/chat/files/projects/
│   │                          #   settings/knowledge/scheduler/workflows/lan/i18n/
│   │                          #   experts/grind/update 共 15 个）
│   ├── skills/                # MCP 内置工具实现（每个文件一个 execute(**params)）
│   └── workflows/             # 工作流 JSON 定义（DAG）
├── frontend/
│   ├── index.html             # 单页入口
│   ├── css/style.css          # 全局样式（双主题 CSS 变量）
│   └── js/
│       ├── app.js             # 主控：初始化、设置页、事件绑定
│       ├── store.js           # 全局 state + 持久化（localStorage + 后端共享双通道）
│       ├── components/        # chat/team/memory/whiteboard/skill_panel/schedule/
│       │                      #   experts/prompt_factory/project_bar/understand
│       └── services/          # api/tools/adapter/markdown/workflow/project/
│                              #   i18n/i18n_dict/dialog/experts/grind/
│                              #   riskguard/usage/file_icons
├── data/                      # 源码运行时的数据目录（勿提交用户数据）
│   └── language.txt           # i18n 语言选择（安装时写入，zh 或 en）
├── docs/                      # 官网英文站（GitHub Pages）
│   └── zh/                    # 官网中文站
├── README.md                  # 英文 README
├── README-zh.md               # 中文 README
├── installer/                 # 各版本安装包
├── desktop.py                 # 桌面端入口（PyWebView + 内嵌 uvicorn）
├── SLATE_Teams.spec                 # PyInstaller 打包规格
└── start.bat / start.sh       # 源码一键启动（uvicorn 127.0.0.1:8000）
```

## 5\. 后端规范

### 5.1 API 约定

* 所有接口统一返回 `{ "code": 0, "data": …, "message": "ok" }`；`code !== 0` 表示业务错误，`message` 必须是人话。
* 前端所有请求经 `frontend/js/services/api.js` 封装（带 180s 超时保护），禁止在组件里裸写 fetch（流式除外，用 `streamChat`）。

### 5.2 新增路由三步走

1. `backend/routers/<name>.py` 中定义 `router = APIRouter(prefix="/<name>", tags=\[…])`；
2. `backend/main.py` 导入并 `app.include\_router(xxx.router, prefix="/api")`；
3. **`SLATE_Teams.spec` 的 `hiddenimports` 追加 `backend.routers.<name>`**（漏掉则安装版 404）。

### 5.3 新增数据文件目录

* 需要随包分发的静态资源目录（如 `backend/workflows/`）必须加入 `SLATE_Teams.spec` 的 `datas`。
* 运行时**可写**数据一律放 data 目录：`Path(os.environ.get("SLATE Teams\_DATA\_DIR", 项目根/data))`，不要写死源码路径。

### 5.4 数据库

* SQLite 表结构变更用迁移模式：`PRAGMA table\_info` 检测 + `ALTER TABLE ADD COLUMN`，不删库重建。
* 连接需设 `timeout=10.0`、`PRAGMA busy\_timeout`，避免并发写锁冲突。

### 5.5 共享设置状态（重要教训）

* `PUT /api/settings/state` 必须是**合并式写入**（先读已有 `desktop\_state.json`，只覆盖本次提交的白名单字段），禁止整体覆盖写，否则漏传字段会被永久抹掉。
* 新增设置项的完整链路（三处缺一不可）：

  1. `store.js`：state 加字段 + 纳入持久化白名单；
  2. `app.js`：控件绑定 `change` 事件**即时** `savePersistent()`（不能只靠"保存"按钮）；
  3. `settings.py`：字段加入白名单集合。

## 6\. 前端规范

### 6.1 版本号机制（强制）

* 所有 `<script>` / `<link>` / `import` 必须带 `?v=YYYYMMDD-N` 缓存戳。
* 每次修改前端文件后**统一 bump**：当日递增 `-N`（如 `20260813-46 → 20260813-47`），替换必须覆盖 `frontend/` 下全部 html/js/css，并校验无旧版本号残留。
* 用 PowerShell 脚本批量替换时，文件必须写成 **UTF-8 无 BOM**（BOM 会导致 JS 加载失败）。

### 6.2 代码组织

* 组件放 `js/components/`，可复用服务放 `js/services/`；全局状态只存在于 `store.js`，通过 `subscribe(key, fn)` 订阅变更。
* 渲染 DOM 优先 `createElement` + `textContent`（防注入）；用户内容禁止直接拼进 `innerHTML`。
* Markdown 渲染统一走 `services/markdown.js`。

### 6.3 LLM 调用

* 统一经 `/api/proxy/chat`（支持流式与非流式 `stream:false`），API Key 由前端从 `getModelKey(modelId)` 取；后端不保存、不代管 Key。
* 流式必须用 `api.js` 的 `streamChat`（内置 idle 看门狗 + 零内容重试），不要自写 SSE 解析。

### 6.4 国际化（i18n）

* **架构**：安装时 Inno Setup 选语言 → `data/language.txt` → `GET /api/i18n/lang` → `i18n.js` 加载词典并翻译。
* **翻译引擎**：`frontend/js/services/i18n.js` 提供 `t(key, vars)` 函数 + MutationObserver 自动翻译静态 DOM 文本/属性。
* **词典**：`frontend/js/services/i18n_dict.js` 维护 ~1000+ 英文键值对（`EN_DICT`）；中文模式下 `t()` 直接返回键名原值。
* **包 t() 规则**：
  - UI 静态文本、toast 消息、弹窗标题/内容——**必须**用 `t()` 包裹。
  - 模型提示词 / 工具返回结果 / 导出内容 / console 日志——**不译**。
  - 拼接式 toast 必须改为 `t(key, {var})` 占位符形式，否则词典无法命中。
* **SKIP\_SELECTOR**：`.msg-content`、`textarea`、`input` 等区域内容 Observer 不翻译，必须在源码中显式包 `t()`。
* **新增前端文案时**：若该文案会显示在界面上，必须同步在 `i18n_dict.js` 的 `EN_DICT` 中添加英文翻译。

### 6.5 弹窗规范（dialog.js）

* **禁止原生 `alert()` / `confirm()` / `prompt()`**——桌面端 PyWebView 下体验差且无法跟随主题。
* 统一使用 `frontend/js/services/dialog.js` 提供的应用内弹窗：`showAlert(msg)` / `showConfirm(msg, onOk)` / `showPrompt(msg, onOk)`。
* 弹窗样式跟随双主题，直角 + 金色强调。

## 7\. 扩展点规范

### 7.1 新增 MCP 内置工具（四处注册，缺一不可）

1. `backend/skills/<name>.py`：实现 `def execute(**params) -> dict|str`；
2. `backend/routers/skills.py`：`BUILTIN_SKILLS` 字典注册名称与描述；
3. `frontend/js/components/skill_panel.js`：`SKILL_PARAM_DEFS` 添加手动执行的参数表单；
4. `frontend/js/services/tools.js`：`skill_run` 工具的 description 补充该工具（模型可见）。

### 7.2 新增工作流

* 在 `backend/workflows/` 放 JSON：必含 `id / name / description / nodes / edges`。
* 节点字段：`id / name / role（团队成员角色）/ model / skill / prompt / inputs / output_key`（可选 `max_tokens` / `temperature`）。
* 输入映射约定：`$input` = 运行时用户输入，`$node_id` = 上游节点输出，其余为字面量；提示词模板用 `{{变量名}}`。
* DAG 合法性（环、未知引用）由 `GET /api/workflows` 自动校验，非法工作流前端会标 ⚠ 且禁止运行。

### 7.3 知识库写入

* 任何自动产物入库都复用 `POST /api/knowledge/docs`（后端 `upsert_document`），带上 `source / kind / metadata`，**禁止另建重复存储**。

### 7.4 新增专家包

* 专家包结构：`persona.md`（人格）+ `rules.md`（规则）+ `data.json`（元数据）+ `knowledge/` + `skills/`。
* 后端接口在 `backend/routers/experts.py`，支持 CRUD + zip 导入/导出。
* 对话模式：下拉选择器 → `persona + rules + 知识清单` 注入系统提示（`adapter.js`）。
* 团队模式：成员卡绑定专家包 → 该成员发言自动带上专家人格与规则。

### 7.5 高危命令审批

* `riskguard.js` 前端拦截 + 后端 `proxy.py` 双层校验：匹配高危模式（`rm -rf`、`format`、`del /s` 等）时弹出审批弹窗，用户确认后才执行。
* 新增高危规则时前后端同步更新匹配列表，不可只改一侧。

## 8\. UI 规范

* 视觉身份「席 · Ledger」，双主题按 `data-theme` 切换：浅色 `#F1F1EF` 石墨纸面 + `#191A1C` 墨字，深色 `#17181B` 墨底 + `#E4E4E6` 字。主强调色是账簿红墨 `#97342A`（浅）/ `#CC7466`（深），落在 `--accent` 与 `--gold` 上——`--gold` 只是原作留下的**名字**，值早已是红墨，不许再往里塞回金色。`--danger` 的报警红与它按深浅分工：红墨深而钝、报警红亮而饱和。
* 字标是「席」；顶栏那颗图标、标签页图标与官网的门面图都用 SLATE 的位图（`frontend/icon.png`，外框走 `--gold-dim` 淡底、直角）。纯 CSS 的两横条方角 mark 在 22px 下读起来是「二」，连同 `frontend/mark.svg` / `docs/mark.svg` 一起撤了，别再引回来；官网那份位图是同一文件的副本（守卫按逐字节比）。
* 颜色一律用 CSS 变量（`--bg / --text / --border / --bg-alt / --gold` 等）；唯一例外：危险/错误色 `#c44`。
* 直角或 ≤4px 圆角（`--radius`），无阴影、无渐变、无毛玻璃（自定义主题的「板块透明度」只是平面 alpha，不许加 `backdrop-filter` 模糊）；字体默认走系统回退，**不随包带字体文件**——用户在「设置 → 自定义主题」里自己导入的字体只落本机 `data/theme/fonts/`，经 `/api/theme/font/{id}` 供 `@font-face` 使用，不进仓库、不进安装包。
* 新增样式追加到 `style.css` 对应功能区块后，命名沿用现有前缀（`team-\* / wf-\* / chat-\* / settings-\*` 等）。

## 9\. 桌面版与发布

* **安装版路径**：`C:\\<user>\\AppData\\Local\\Programs\\SLATE Teams`；其数据目录为 `…\\SLATE Teams\\data`（`desktop.py` 设 `SLATE_DATA_DIR`），与源码 `data/` 相互独立。
* **纯前端改动**：`robocopy frontend "…\\SLATE Teams\\_internal\\frontend" /MIR` 即时生效。
* **任何后端 Python / 资源目录改动**：必须重新执行 `build_desktop.bat` 打包才生效；安装包另走 `build_installer.bat`。
* **Inno Setup 语言选择页**：`[Code]` 段 `InitializeWizard` 创建语言选项页，`CurStepChanged(ssPostInstall)` 写入 `data\language.txt`；静默升级时保护已有选择（`WizardSilent and FileExists` 跳过）。
* **Inno Setup 版本**：本机使用 Inno Setup 7（非 6），`build_installer.bat` 已兼容。
* **PyInstaller 6 行为**：onedir 模式 datas 落在 `dist\SLATE Teams\_internal\`（如 `_internal\frontend`）；`sys._MEIPASS` 指向 `_internal`。
* **双语文档**：`docs/` 为英文站，`docs/zh/` 为中文站；`README.md` 英文 / `README-zh.md` 中文；均含语言切换链接。
* `docs/` 是官网（GitHub Pages，main 分支），推送后自动更新。
* **公开线只走 squash**：远端 `SLATE-Teams` 的 `main` 由本地 `publish` 分支（单提交快照）推出去，**不带上游 SLATE 的提交史**——祖先提交 `85fa8f6f` 里的 `data/desktop_state.json` 含两把真 Key，整段历史一起推必被 push protection 拦下（该仓 `secret_scanning_validity_checks` 是关的：只认形状不认死活，撤销 Key 也不会放行）。日常提交照旧在 `main`（保留完整历史、跟踪 `upstream`）；要发布时 `git checkout publish && git read-tree -u --reset main && git commit -m "release: …"`（把 publish 的树整体换成 main 的树，父提交仍是上一版快照，所以永远快进），再 `git push SLATE-Teams publish:main`。**禁止**把 `main` 直接推给 `SLATE-Teams`，也禁止在 `publish` 上做普通 `merge`（那会把旧对象变成可达）。

## 10\. 提交前自检清单

1. Python：`python -m py_compile <改动文件>`；路由级改动用直接调用端点函数验证（本机 TestClient 有兼容问题）。
2. 前端完整性：`check_frontend.bat`（或 `node scripts/check_frontend_integrity.mjs`）。必须通过 JS ES module 解析、HTML 残片扫描、乱码/残缺标签扫描与缓存版本号一致性检查。
3. JavaScript：若只想快速检查单文件，可补充运行 `node --check <改动文件>`；最终仍以 `check_frontend.bat` 为准。
4. 前端版本号已统一 bump，且全仓库 grep 无旧版本号残留。
5. 涉及后端时，`SLATE_Teams.spec` 的 `hiddenimports` / `datas` 已同步。
6. 涉及新设置项时，确认 change 即时保存 + 后端白名单 + 合并式写入语义未被破坏。
7. 新增界面文案时，`i18n_dict.js` 的 `EN_DICT` 已同步添加英文翻译。
8. 不要提交 `data/` 下的用户数据、`desktop_backend.log`、`.tmp-*` 临时目录、`outputs/`。

### 10.1 Agent 防回归护栏

* 禁止对 `frontend/`、`docs/`、`README*.md`、`RULES.md` 做未经验证的批量重编码、批量转码或跨编码保存；所有文本文件保持 UTF-8。
* 编辑 `frontend/index.html` 或任何拼接 `innerHTML` 的 JS 后，必须运行 `check_frontend.bat`。
* 若检查报告出现裸露 `/div>`、`/span>`、`/button>`、`/option>`、`/small>`、`title="...type="button`，必须先修复再继续提交。
* 若检查报告出现疑似 mojibake（如 `锛`、`绛`、`涓`、`鍚`、`棣`、`閫`、`鈥` 等连续乱码），必须回到上下文或旧版本核对原文，不得用猜测批量替换。
* 可运行 `powershell -ExecutionPolicy Bypass -File scripts/install_pre_commit.ps1` 安装本地 Git pre-commit hook；安装后每次提交会自动执行前端完整性检查。

## 11\. 代码风格

* 注释用中文，精炼说明"为什么"而非复述代码；与周围代码的密度、命名保持一致。
* 函数保持短小单一职责；错误必须给用户可读的中文信息（`⚠ / ✗` 前缀沿用现有惯例）。
* 不做投机性抽象：能用现有链路（proxy / skills / knowledge）就不新建平行机制。

