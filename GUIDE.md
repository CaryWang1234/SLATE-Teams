# SLATE Teams 使用教程 · User Guide

> [中文](#中文) | [English](#english)
>
> 线上入口：官网 [slate-ai.site](https://slate-ai.site/) ｜ 文档站 [docs.slate-ai.site](https://docs.slate-ai.site/) ｜ 本教程网页版 [slate-ai.site/guide.html](https://slate-ai.site/guide.html)

---

<a id="中文"></a>
## 📜 中文教程

### 目录

1. [SLATE Teams 是什么？](#1-slate-teams-是什么)
2. [安装与启动](#2-安装与启动)
3. [多模型对话](#3-多模型对话)
4. [Agent Autopilot](#4-agent-autopilot)
5. [Harness 自主执行](#5-harness-自主执行)
6. [磨墨模式](#6-磨墨模式)
7. [团队](#7-团队)
8. [白板逻辑链](#8-白板逻辑链)
9. [MCP 工具箱](#9-mcp-工具箱)
10. [专家包](#10-专家包)
11. [工作流模板](#11-工作流模板)
12. [知识库与灵光](#12-知识库与灵光)
13. [Code Review](#13-code-review)
14. [语音输入](#14-语音输入)
15. [截图转代码](#15-截图转代码)
16. [定时任务](#16-定时任务)
17. [设置与个性化](#17-设置与个性化)

---

### 1. SLATE Teams 是什么？

SLATE Teams 是一款**本地优先**的 AI 协作调度台。它把主流大模型、35 个内置工具、团队辩论、DAG 工作流、白板式逻辑链整合在一个轻量界面里——零 npm、零构建、开箱即用。

核心理念：**让灵感直达行动，中间不隔工具摩擦。**

---

### 2. 安装与启动

#### 方式一：安装包（推荐）

前往 [GitHub Releases](https://github.com/CaryWang1234/SLATE-Teams/releases) 下载 `SLATE-Teams-Setup-x.x.x.exe`，双击安装即可。

装好后点窗口右上角的 X 不会结束应用：SLATE Teams 缩进系统通知区域继续跑，正在生成的那一轮照常收工，手机端的局域网连接也不掉。双击托盘图标（或右键「显示主窗口」）找回窗口，右键「退出 SLATE Teams」才真的退出，第一次缩下去会弹一条气泡提示。托盘只用 Windows 原生 API 实现，不引入第三方依赖；非 Windows、或这个登录会话根本没有通知区域时，关窗退回原来的直接退出。

同一份安装只会开一个 SLATE Teams 窗口：窗口已经开着、或者已经缩进通知区域时再双击一次图标，不会多出一个窗口、也不会多起一份后端——新进程会把正在跑的那个窗口唤回前台（抢不到前台时让任务栏图标闪一下），然后自己退掉。锁随进程消失，崩溃或被任务管理器结束都不会把应用变成「再也打不开」；装到另一个目录的副本算另一份安装，可以与这一份同时跑。

#### macOS

前往 [GitHub Releases](https://github.com/CaryWang1234/SLATE-Teams/releases) 下载 `SLATE-Teams-Setup-x.x.x.dmg`，双击挂载后把「SLATE Teams」拖进「应用程序」。这个 `.dmg` 由 CI 直接产出，只做了 ad-hoc 签名、没有公证，首次打开会被 Gatekeeper 拦一次：在访达里右键（或长按）图标 → 「打开」 → 再点一次「打开」，此后就能双击启动。如果对话框写的是「已损坏，无法打开」（只有「移到废纸篓」，没有「打开」按钮），说明系统没认到签名，改用这条命令去掉隔离标记再打开：`sudo xattr -dr com.apple.quarantine "/Applications/SLATE Teams.app"`。

安装版的数据不在 `.app` 包里，而在 `~/Library/Application Support/SLATE Teams`：对话历史、API Key、后端日志和 WebView 的个人资料都在这里。替换 `.app` 升级不会动你的数据，包体也不会在运行时被写脏——将来真签名公证时，那种改动是会废掉签名的。源码运行仍然把数据放在仓库的 `data/`。

窗口用 macOS 原生的 WKWebView 渲染，Windows 用 Edge WebView2，两套内核各自的偏好与缓存互不相通。「设置 → 关于」里的检查更新在 Mac 上给出的是这一平台的 `.dmg` 链接，不会推一个双击打不开的 `.exe`；发布产物里找不到匹配文件时退回 Releases 页面。

键盘上 `⌘ + N` 新建对话、`⌘ + D` 切换明暗，`Ctrl` 组合同样有效；焦点在白板画布里时 `⌘ + D` 归给「复制选中的卡片」这条绑定，不会去翻明暗。界面正文走系统字体（苹方），代码走 SF Mono / Menlo，Windows 上仍是微软雅黑与 Consolas。

高危命令的清单按平台补齐：`diskutil erase`、`diskutil reformat`、`diskutil partitionDisk`、`diskutil secureErase`（抹盘、重分区）会先弹审批；`rm -rf /`、`rm -rf ~`、`mkfs`、`dd if=` 这类灾难级命令无条件禁止，连审批都不走。

Mac 上还没有这两件事：通知区域常驻与「一份安装只开一个窗口」目前只在 Windows 上实现——关窗口就是退出，重复启动会再起一份。另外，这一轮 macOS 改动是在 Windows 上把「平台」当实参、将 Darwin 分支执行并断言验证的，`.app` 与 `.dmg` 尚未在真机上跑过。

#### 方式二：源码运行

```bash
git clone https://github.com/CaryWang1234/SLATE-Teams.git
cd SLATE-Teams
pip install -r requirements.txt
python desktop.py
```

源码启动后访问 `http://127.0.0.1:8000`。

#### 首次配置

1. 点击顶栏的 **设置** 页签
2. 在「模型」栏添加你的 API Key（支持 OpenAI / Claude / Gemini / DeepSeek / 自定义端点）
3. 选择默认模型，即可开始对话

---

### 3. 多模型对话

SLATE Teams 支持同时接入多个模型，在对话界面顶部下拉框随时切换。

**操作要点：**
- 点击模型下拉框 → 添加/切换模型
- 不同对话可使用不同模型
- 支持本地模型（Ollama / LM Studio 的 OpenAI 兼容端点）
- 模型名旁边画品牌 mark：内置模型与自己添加的模型都按名字认，认得出的按品牌自己的颜色画（没有彩色原件的画中性灰单色），认不出就什么也不画，不会拿别人的 logo 顶替；自定义主题不会把品牌色染掉
- 每条回复显示模型名称与 Token 用量

**左侧「任务」列表：**
- 排序可切换：最近更新 / 按项目 / 按状态 / 创建时间 / 按用量；偏好跨设备同步，经典布局与 Codex 历史栏共用同一份
- 每条会话按当下处境给出独立标志：**需要操作**（上一场被停止或还有下一步）、**出错**、**进行中**（呼吸动画，只在这一场真的在生成时出现）、**已完成未查看**（点进会话即清除）
- 标志记的是"上一场怎么结束的"：若在别处（如手机遥控）继续过这条会话，旧标志自动作废

**消息区右侧「任务清单」栏：**
- 大任务跑起来时逐条展示进度；点顶栏「任务清单」按钮（Codex 布局在输入框上方那行）即可整栏收起，把宽度还给消息区，再点一下展开
- 收起是记在你这台机器上的偏好：刷新、重启都保持折叠，清单继续往下跑也不会擅自把栏撑回来
- 折叠期间按钮悬停会报 `{done}/{total}`，进度不至于彻底隐身；这场没有清单时按钮置灰

**输入框右端「优化提示词」（✦，在语音按钮左边）：**
- 写了一半觉得说不清，点一下把这段草稿交给当前模型改写一遍
- 改写结果先与原文并排放在弹窗里比对，只有点「采用」才写回输入框
- 点「保留原文」、按 Esc、点弹窗外面都不算采用，输入框一个字都不会变
- 等结果期间你又改了草稿（包括语音听写实时写进去的字），这次结果会被放弃，不会盖掉你新写的
- 用哪个模型可在「设置 → AI 辅助功能 → 提示词优化」单独指定；关掉后一次请求都不发

**快捷键：**
- `Enter` 发送消息
- `Shift + Enter` 换行
- `Ctrl + N`（Mac 上 `⌘ + N`）新建对话
- `Ctrl + D`（Mac 上 `⌘ + D`）切换深浅色；焦点在白板画布里时这条归复制卡片

---

### 4. Agent Autopilot

Autopilot 是默认的“少打继续”执行层。只要你的消息明显是在要求 SLATE Teams 查看项目、修改文件、运行命令、排查 bug、提交代码或生成文件，它会自动进入多轮 Agent Loop。

**你怎么用：**
- 直接说“修复 xxx”“排查项目 bug”“优化工具调用”“跑一下测试并修掉报错”
- 不需要手动开启 Harness，也不需要反复发送“继续”
- 普通任务最多自动推进 24 轮；全面扫描、项目级、多文件任务最多 40 轮
- 轮数是止损线不是预算：交付并逐项验证通过后，模型调用 `exit_autopilot` 收口，循环随即结束
- 轮数用完不等于干完：默认开启的 **Continue Autopilot** 在末轮不松手。上一轮还在执行工具时，把上限往后推 8 轮（最多推 3 次），让它把手上的活做完；上一轮空手停笔时，把清单剩余项念回给它，催它继续推进或明确写【任务完成】。不想要这个行为，去「设置 → 自动推进」取消勾选
- 追加的额度也用完了、循环真的散场时，系统替你按下那颗「继续跑完」：每一场最多自动续 2 次，续出来的那一场照常走完成通道收口，屏幕上会弹出「轮数用尽 · 已自动续跑（第 1/2 次）」告诉你这不是你点的。两种情况它不动手——这一场切到了「手动审批」档（那一档的语义就是每步都要人点头），或「设置 → 自动推进」被关掉了；这时「继续跑完」条原样挂在那里等你点。等这一场真的空闲下来（末轮的压缩、记忆整理还在占着它）才按，切去看别的会话时也不抢那一屏

**它会自动做：**
1. 读取相关目录、文件、配置或 Git 状态
2. 调用 `file_edit` / `terminal` / `git_tool` / `code_scan` 等工具推进
3. 把工具结果隐藏回灌给模型，让它继续下一步
4. 修改后重新读取、运行检查、测试或构建
5. 没有工具记录却口头说“完成”时，系统会要求它先验证
6. 跑到轮数上限而任务还没干完时，按 Continue Autopilot 追加轮数并接着推进（可在「设置 → 自动推进」关掉）

**砚流 · 落笔即所见：** 模型正在逐个 token 写工具参数时，SLATE Teams 会按本地工具 schema 解析这份还没写完的参数，实时演成一行预览——哪些字段已经闭合、哪个字段正在写。它只做预览，**半成品参数永不触发执行**；几十 KB 的正文类字段一律折叠成行数与字数，不刷屏。

**停止是真取消：** 点击停止会同时关闭模型流与工具调用的流式通道，后端随即终止对应的子进程与在跑任务，不再是“界面停了、活还在干”。被取消的调用会以独立状态记进本地事件账，与正常完成区分开。

**回答被截断会说清楚：** 思考过程与正文共用同一个输出上限，思考吃满时这一轮就没有正文可写了。这种结局不再被静默咽下去：流收到内容后自然结束、却既没有结束标记也没有结束原因时，这一轮会被标记，收尾时如实报出，原因也分开说（思考占满输出上限 / 上游提前中断），并给出可点的「继续」入口；正文有内容但流提前断掉的标注可能不完整。这套提示在任何模式下都给，不只是自动推进模式。

**本轮写了哪些文件，说完就摆出来：** 这一轮真的往磁盘写过文件（编辑 / 新建 / 追加）时，模型说完最后一句话后，消息末尾挂出一张卡片——改了哪几个文件、各自行数增减，展开可逐文件看 diff。点「撤销」把这一轮写过的文件还原成本轮开始前的样子（本轮新建的一并删掉），执行前过一道红色确认；你在本轮之后又自己改过的文件只跳过并如实写明，撤回不会吃掉你自己的修改。原文快照存在 `data/round_snapshots/`，只留 7 天、超过 2MB 的大文件不存原文（这类同样跳过并写明原因），全部留在本机；移动端只读展示这份清单，撤销留在桌面端。

**什么时候还用 Harness：** 需要更强约束、明确 TODOLIST、长任务 80 轮闭环时，点击输入框左侧 **＋** 菜单里的「目标模式」开关；验证全部通过后模型调用 `exit_target_mode` 收口，目标模式开关随之关闭。

---

### 5. Harness 自主执行

Harness 是 SLATE Teams 的「自动驾驶」模式——你只需说清目标，模型自主规划、调用工具、多轮执行直至完成。

**启动方式：**
- 点击顶栏 🚀 按钮
- 或在消息中提及「用 Harness 执行」

**六阶段流程：**
1. **目标理解** → 解析你的需求
2. **计划制定** → 拆解为可执行步骤
3. **工具执行** → 自主调用文件/终端/搜索等工具
4. **验证检查** → 确认每步结果
5. **汇报总结** → 输出执行报告
6. **追溯归档** → 记录到 TODOLIST

**特性：**
- 最多 80 轮自主调用，验证通过后由模型调 `exit_target_mode` 显式收口
- 中途可暂停（仅中断当轮，不丢失进度）
- 自动建立 TODOLIST 统筹大任务（消息区右栏实时展示；顶栏「任务清单」按钮可随时折叠/展开，折叠后按钮上仍报 `{done}/{total}` 进度）
- 异常自动恢复推进

---

### 6. 磨墨模式

把粗糙想法研磨成结构化任务书（墨稿）的交互式引导。

**启动方式：**
- 输入 `/grind 你的想法`
- 或点击 🖌 按钮
- **新增**：输入抽象任务（如"制作一个网站"）时自动建议切换

**三段式流程：**

| 阶段 | 说明 |
|------|------|
| 接墨 | AI 复述你的想法，列出 3-5 个待澄清缺口，只问第一个 |
| 磨墨 | 逐轮追问，一次一问，选择题优先（最多 10 轮） |
| 收墨 | 输出结构化 JSON 墨稿，含目标/交付物/验收标准 |

**收墨触发：** 输入「收墨」「够了」「就这样」或达到轮数上限

**墨稿三键：**
- 送入 Harness → 直接执行
- 投到白板 → 可视化推演
- 存为模板 → 复用

---

### 7. 团队

多个 AI 角色围绕你的问题进行多轮辩论，最终输出共识结论。

**启动方式：** 点击顶栏「团队」标签

**这一页怎么排：** 团队是与「对话」同级的顶层页签，点开是一张三栏会议桌——左栏**在场**（席位与这一场的
来历：模型席位、真人席位、预设与历史场次）、中栏**议事流**（发言、轮次标尺与工作流）、右栏**待你签字**
（把散在发言流与名册里的停点聚合成一份：等你签字、等谁开口、谁不在场；点一条滚到那一格并划一下，
动作仍在那一格上做，右栏不放第二颗按钮）。「决策需我拍板」那颗也在右栏，因为它讲的是这一场的规矩。
右栏是主持人的视图：手机那一页（局域网遥控 / 与会者页）只当得了与会者，当不了主持人。

**流程：**
1. 选择团队成员（预设 9 种角色组合，或自定义）
2. 输入问题
3. 各成员按角色依次发表观点（最大轮数可选 3 / 5 / 8 / 10，默认 5 轮；决策一出现就收口）
4. 决策者给出结论；勾着「决策需我拍板」时到这里停住，等你签字

**决策停点：** 「决策需我拍板」默认开着——采纳才算收口；选「继续讨论」则带着「未拍板」再辩一轮
（重开有上限，不会一直烧 token）。夜间模式（全托管）不弹窗打断，但那一行照画并写明是自动采纳，
不读成你点过头；取消勾选就回到"决策即结束"。

**发言的账：** 某位成员这轮请求失败或没配 API Key，那一格标「失败」/「未参与」——不进下一位的上下文
（模型不会把一句报错当成某人的主张接着反驳），也不算进发言数与星图。

**背后跑：** 你切回对话面板时辩论继续跑，待拍板与收口都进右栏任务中心那一张表（与后台终端任务、
子代理批次同一族），点行上的按钮跳回这一场；手动停止的那场进历史并标「已中断」，点开看得见已完成的发言。

**自定义团队：**
- 设置 → 团队管理 → 添加/编辑/删除成员
- 每个成员可指定模型、角色、人设

**讨论记录：** 每次发言除了写进本机历史，还会落进后端（团队会话 + 名册 + 每人一次事件账本 run），
黑板 · 工作流视图的星图读的就是这份；落库失败时历史仍在，列表里标「仅本机记录」。

---

### 8. 白板逻辑链

可视化的卡片 + 连线系统，用于梳理思路、推演方案。

**操作：**
- 点击「黑板」标签进入
- AI 可自动创建卡片（分析结果、方案对比等）
- 手动拖拽卡片、建立连线
- 顶栏可切换 Git / 流程 / 看板 / 纲要等显示模式；主黑板就是默认自由画布
- Git 树会识别当前项目的 Git 要素：HEAD、branch、remote branch、commit、tag、remote、worktree、stash、暂存 / 修改 / 未跟踪、未推送提交；节点和视野都可拖动
- 支持 4 种 AI 白板工具：
  - `card_create` 创建卡片
  - `card_edit` 编辑卡片
  - `arrow_create` 建立连线
  - `board_summarize` 总结全局

**第 5 档「工作流」：把"怎么跑"和"跑得怎么样"放进同一屏**
- 控制条：停止 / 继续跑完 / 自动推进（目标模式）/ 回复方式 / 思考强度。
  这些控件不另存一份状态，写的就是聊天框顶部那套共用的状态，两处永远一致
- 流程卡片墙：`data/actions/*.yml` 里每份流程说明书一张卡，卡面写清共几步、几项输入、
  谁写的、产出落到哪；「运行此流程」以 @提及 发进当前对话，「看步骤」就地展开步骤清单（懒加载）
- 置顶与「只看置顶」存在本机 `slate_board_wf_prefs`，只影响这一屏的排布
- 当前运行：直接从事件账本投影——哪一步在跑、跑了多久、成没成；
  活数据只改自己那截 DOM 的文本，运行中每秒一跳不会把整块看板抖散
- 团队星图：按角色摆出这场对话最近一次团队讨论，谁回应了谁、谁动过哪些工具、
  谁派生了子代理，全部取自后端真实记录；没有团队记录时这里会直说，不画装饰性的图

---

### 9. MCP 工具箱

SLATE Teams 内置 35 个 MCP 工具，模型在对话中自主决定何时使用。

**使用方式：**
- 直接描述需求（如"帮我搜索 xxx"）
- 或 `@工具名` 显式调用

**工具分类：**

| 类别 | 工具 |
|------|------|
| 文件操作 | `file_tree` `file_peek` `file_create` `file_edit` `file_append` |
| 终端 | `terminal`（沙箱执行，高危命令需审批） `bg_task`（后台终端任务：起了就返回，结束会叫醒模型） |
| 检索与代码 | `code_search` `code_scan` `doc_scan` `repo_stats` `todo_scan` `python_api_extract` |
| 文档生成 | `doc_write` `ppt_create` `word_create` `html_render` `html_bundle` |
| 办公与 PDF | `excel_tool` `pdf_tool` |
| 数据处理 | `json_tool` `regex_test` `text_summarize` `chart_create` `qrcode_create` |
| 网络 | `web_search` `web_fetch` |
| 系统与环境 | `system_info` `git_tool` `css_color` |
| 自动化 | `browser_automation` `computer_use` `screenshot_to_code` |
| AI 生成 | `image_gen` `video_gen`（需在设置中配置模型与 API Key） |
| 扩展 | `mcp_factory`（工具工厂：生成的工具落 `data/evolved/`，可在「扩展 → 新功能」停用/回滚/撤销） |

**特殊字符与编码：**
- `file_peek` / `file_edit` 自动识别 UTF-8、UTF-8 BOM、GB18030、GBK、UTF-16 等常见文本编码
- 中文、emoji、全角符号会原样保留；如果旧编码无法表达新字符，工具会安全升级写入编码而不是丢字符
- Windows 下 `terminal` 会隐藏 PowerShell 子窗口，并对 Python / Node / Git / npm / rg 等原生命令做 Unicode-safe 输出捕获
- Windows 下 `terminal` 一条命令一个 PowerShell 进程：多行块（`foreach` / `if`）直接执行，`&&` / `||` 在 PowerShell 5.1 上自动翻成 `if ($?)` 嵌套，语法错误带非零退出码原样返回；会话保持 `cd` 与 `$env:`（PowerShell 变量不跨命令），裸 `python` / `node` 这类交互式 REPL 拿不到输入会立刻退出

**两类后台活：**

- `bg_task`：终端里的耗时活儿（起服务、编译、训练、长测试）交给它，`action=start` 立刻返回，模型不必守着；结束时（或命中你给的正则）系统带着输出尾巴把模型叫醒。任务活在 SLATE Teams 后端进程里，日志落在 `data/bg_tasks/`
- `subagent_run` 带 `background=true`：并行子代理这一批也可以转后台，模型拿到任务编号就继续干别的，跑完后各份结论走同一条「后台任务消息」通道回来叫醒模型（唤醒、徽标与终端任务共用一套）。区别只在寿命——这一批活在浏览器页面里，刷新或关掉页面即止
- 两路后台排在右栏「后台任务」面板的同一张列表里，看状态、看输出/结论、就地停止都在那儿；同时最多 3 批子代理在跑

**Actions 流程说明书：**

上面的工具是「手」，Action 是「步骤约定」——把某件重复任务的必要流程写成一份 yml，模型按它推进，而不是每次重新猜。

- 位置：`data/actions/<id>.yml`，一个文件一份流程，文件名（去掉 `.yml`）就是它的 id
- 字段：`name`、`description`、`when`（什么时候该套用）、`inputs`（要问用户拿什么）、`steps`（每步 `title` + 可选 `tool` / `detail` / `check`）、`output`、`tags`
- 智能体态下模型自动看到 Action 目录（最多 20 条，超出只报数量并指向 `actions_list`），确认要用时调 `actions_read` 读完整流程，再按步骤实际执行；对话态没有工具，整段目录都不注入
- 读到流程不等于做过流程：步骤里标了建议工具的，仍要真调工具完成，模型不会因为「读过 yml」就声称已经执行
- 写坏的 yml 不会凭空消失：顶部「扩展」页的 Actions 栏里会连同「第 N 行：原因」一起列出，工具返回里也会告诉模型哪些暂时不可用
- 格式用的是极简 YAML 子集（2 空格缩进、块数组、`|` 字面量块），Tab 缩进、锚点、多文档等一律拒收；单文件上限 64 KB
- 面板可编辑：顶部「扩展」页 → Actions 栏，点「＋ 新建 Action」或点已有条目进编辑器；边写边校验，报错按「第 N 行：原因」显示，校验没过就保存不了
- 每次覆盖或删除都会先把原文留底到 `data/actions/.history/`（每份最多 5 版），编辑器里的「历史版本」可查看任意一版或直接回滚
- 模型也能写：`actions_write` 工具要求它先在 yml 里声明 `author: model`（面板据此打上「模型代写」徽标），且这一场开着「手动审批」时会弹窗给你审批；切到「自动审批 / 完全访问 / 夜间模式」则不弹窗——写坏可以回滚，但格式校验永远会拦住不合格的内容
- 聊天框输入 `@<id>` 可把整份流程注入这条消息（注入有 6000 字上限，超出部分提示模型用 `actions_read` 读全）

**自进化工具（工具工厂）：**

`mcp_factory` 让 SLATE Teams 把自己缺的工具写出来给自己用。产物一律落在 `data/evolved/`（用户数据区），一个工具两份文件：`<name>.py` 是生成的代码，`<name>.json` 是说明与参数。

- 为什么不写进 `backend/skills/`：那是程序自己的源码树——一次升级就把攒下的自产工具整个冲掉，而且程序不该在运行时改自己。`data/` 升级覆盖不到，重启后清单照读
- 管理入口：顶栏「扩展」→「新功能」栏。每条都写明当前状态：正常 / 已停用 / 代码有问题（带第几行语法错误）/ 与内置工具同名（已由内置接管）
- 停用是从模型的工具体系里整条摘掉，不是「调用时再报错」；随时可以再启用
- 覆盖、撤销、回滚都先留底到 `data/evolved/.history/`（每个工具最多 5 版），条目弹窗的「历史版本」可查看任一版并回滚；回滚也是写，编译不过的旧版本不许盖回去
- 语法不过的生成代码根本不落盘（只编译自检，绝不替你执行一次）；与内置工具同名的创建请求当场拒绝
- 同名冲突时内置优先：升级若带来了同名内置工具，那份自产代码会被顶掉并标出来——看得见、随时可撤，不必跟新版较劲
- 历史版本遗留在 `backend/skills/` 里的产物会在启动时自动复制进 `data/evolved/`（只复制，不删程序自己目录里的文件）
- `@` 提及与 `skill_search` 都能找到这些工具，系统提示里会点名当前启用的自产工具

---

### 10. 专家包

预制的角色知识包，让 AI 以特定专家身份回答。

**使用：**
- 对话界面左侧「专家」下拉框选择
- 内置样例：创意写作导师

**导入/导出：**
- 设置 → 专家包管理 → 导入 `.zip` / 导出为 `.zip`
- 专家包结构：`persona.md`（人设）+ `rules.md`（规则）+ `knowledge/`（知识）+ `skills/`（技能）

**创建自定义专家：**
1. 新建文件夹，按上述结构放入文件
2. 打包为 `.zip` 导入
3. 或直接通过 UI 创建

---

### 11. 工作流模板

预定义的 DAG 工作流，多节点并行执行复杂任务。

**内置 8 个模板：**

| 模板 | 用途 |
|------|------|
| 默认开发流程 | 通用开发任务 |
| 并行研究流程 | 多维度并行调研 |
| Bug 排查流程 | 日志/代码/环境并行分析 |
| 代码审查流程 | 质量/安全/性能并行审查 |
| 数据分析流程 | 趋势/异常/统计并行分析 |
| 文档生成流程 | 大纲→正文→摘要→整合 |
| 产品需求流程 | 想法→用户故事→功能→PRD |
| 研究报告流程 | 课题→调研→方案→报告 |

**管理：**
- 团队面板 → 工作流 → 导入/导出/删除自定义模板

---

### 12. 知识库与灵光

**知识库：** 长期存储项目知识，对话时自动注入相关上下文。

- 设置 → 记忆与画 → 知识库标签
- 手动添加笔记、项目背景、资料摘录
- 支持 Markdown 格式

**灵光（Spark）：** 对话结束时自动捕获有价值的技术洞察。

- 对话结束 → 系统检测是否有可归档的洞察
- 确认后自动存入知识库
- 无需手动操作

---

### 13. Code Review

对 Git 仓库的变更进行 AI 四维度结构化审查。

**使用：**
- 设置 → Code Review
- 选择仓库路径
- AI 读取 `git diff` → 分析代码质量/安全性/性能/可维护性
- 输出行级评论 + 汇总报告

---

### 14. 语音输入

浏览器端语音转文字，免打字输入。

**使用：**
- 点击输入框旁的 🎤 按钮
- 说出你的想法，实时转写到输入框
- 再次点击停止
- 支持中英文自动检测

**注意：** 需浏览器支持 Web Speech API（Chrome / Edge 已支持）

---

### 15. 截图转代码

将截图还原为 HTML/CSS 代码。

**使用：**
- 在对话中描述「把这个截图转成代码」
- 或 `@screenshot_to_code` 指定图片路径
- AI 视觉模型分析图片 → 生成对应 HTML/CSS

**支持格式：** PNG / JPG / JPEG / GIF / WebP / BMP / SVG（≤10MB）

---

### 16. 定时任务

让 AI 定时或按事件自动执行任务。

**使用：**
- 点击顶栏 ⏰ 按钮
- 新建任务 → 设置名称、触发条件（定时/事件）、执行内容
- 支持 Cron 表达式

**触发类型：**
- 定时：每隔 N 分钟/小时/天
- 事件：文件变更、对话结束等

---

### 17. 设置与个性化

**主要设置项：**

| 设置 | 说明 |
|------|------|
| 模型管理 | 添加/删除 API Key，配置自定义端点，可选启用 Responses API |
| 推理强度 | 点输入框左侧胶囊开滑杆弹窗，按模型能力给出可选档位（自动/关/低/中/高），每档下方小字标注对应墨色（随墨/清墨/淡墨/浓墨/焦墨）；能力分九类：强制思考的模型没有「关」档，只能整体开关的端点标注「低/中/高都按开」，接不住的档位置灰并写明原因，上游 400 点名该字段时剥掉重发一次；拖动松手才落盘 |
| 上下文预算 | 模型行上「最大上下文」= 按该模型窗口生成的滑杆 + 精确数字框 + 「探测窗口」。自动档取这个模型自己的标称窗口 ×0.8，不再吸附公共档位（8K 的本地模型拿到 6553，而不是把窗口占满没地方写回复）；数字框保留你填的精确值（131072 就是 131072，只在 1K–4M 内夹取）；本地/自定义端点可一键探测真实窗口（Ollama / llama.cpp / vLLM / OpenAI 兼容），探到的值单独存着、可一键清除。同一个值同时决定自动压缩阈值与用量条分母 |
| 输出控制 | 最大 Token 数、流式输出开关 |
| 自动推进 | Autopilot / 短回复审阅 / 长回复停顿审阅 / Continue Autopilot（末轮续跑 + 轮数用尽自动续跑，非手动审批档才动手） |
| 审批模式 | 四档：手动审批（执行命令、访问网络逐条确认）/ 自动审批（只拦 24 类高危）/ 完全访问（命令与联网都不问，缺条件时仍弹选择题问你一句，胶囊标红）/ 夜间模式（全托管：命令、联网、连反问都不问，自己拍板继续，胶囊标夜紫）。这里定的是每个对话的默认档，单个对话在输入框的审批胶囊里随时改。夜间模式下面还有一颗「跑任务时不让电脑睡眠」：只挡系统睡眠，屏幕照常熄灭，合盖、手动睡眠、已经睡着的机器都叫不醒；钉住的是这一场真在跑的那段时间，页面刷新或崩掉后租约最迟 60 秒自动交还；由桌面端界面持有，手机端那一页跑的任务、没有前端在跑的定时任务与后台终端任务都不钉，这一版只在 Windows 上生效 |
| 回复模式 | 输入框左下的模式胶囊，内置四档且各有图标与颜色：智能（全部工具，提示词与旋钮都不动，默认）/ 对话（不调用工具、单轮直答）/ 经济（只读工具白名单 + 低推理强度 + 收紧轮数）/ 狂暴（全工具 + 高推理 + 放宽轮数）；切换只改这一场，换会话各用各的，新对话从默认档起。默认档与自定义模式都在「扩展 → 模式」里建与管理；模型也能用 `mode_write` 建 / 改 / 删模式（追加提示词 + 工具白名单 + 推理强度 + 轮数上限），手动审批档下弹窗把这次改动给你看。白名单是真拦：没开放的工具既不下发到原生 schema 与文本目录，凭记忆硬调也在执行口被挡下并说明是模式所限 |
| 局域网遥控 | 开关 + 访问地址与二维码；关掉即释放监听端口（不是藏起地址），开关只能在本机拨，手机端拨不动；无桌面环境的机器可 `SLATE-Teams --remote` 直接起遥控、不开窗口 |
| 主题 | 深色/浅色切换（顶栏按钮与 Ctrl+D）；自定义主题开着时这颗按钮会锁定，点下去说明原因而不换色 |
| 自定义主题 | 四个源色（底色 / 面板 / 正文 / 强调）推导整套配色 + 正文与代码字体（也能导入自己的字体文件）+ 板块透明度 + 本机背景图与遮罩浓度；还能取 Wallpaper Engine 正在用的那张壁纸的预览图当背景（只读它的配置与 preview，不启动它、不改它设置，它换了要再点一次）；项目栏文件类型图标也跟着强调色现算（多色图标按色相染色）；10 套预设，改任一格即脱离预设高亮，开关跨设备同步、图与字体只留本机 |
| 语言 | 中文/English——按钮与区块标题之外，输入框 placeholder 与悬浮提示也走词典；用户与模型写的内容一律不翻，品牌字标「席」用 `data-i18n-skip` 豁免 |
| 会话归档 | 「任务」栏每一行悬停都有归档：归档只让这一场从任务列表离场，不是删除；正在生成的那一场会被拦下并说明原因。归档过的会话在这一栏逐条恢复（回到任务栏）或删除——删除前先确认，删下去连消息一起清掉 |
| 上下文压缩 | 自动/手动压缩历史对话；摘要发给模型的是完整原文，界面上折成一条可展开的折叠条。系统催办与工具结果投喂这类隐藏轮只进上下文、不占消息区，压缩后重建保留段也不会把它们画成气泡 |
| AI 辅助功能 | 对话以外的 15 项耗 Token 功能逐项开关 + 单独选模型（含自动会话标题：新对话跑完首轮补一个短标题，只替换还是「首条消息前 30 字」那种占位标题，手动改过的名字不动）；关掉即一次模型都不发，工具类的三项（子代理/图片/视频）还会从工具目录里消失 |
| 多任务与项目 | 切走会话是否让它继续在跑（关掉即旧语义：切换即中断）、同时最多运行几场（1–4）、同一项目内最多几场（1–3，默认串行）；排队中的任务在右栏任务中心与输入框上方都看得见 |

---

<a id="english"></a>
## 📜 English Guide

### Table of Contents

1. [What is SLATE Teams?](#1-what-is-slate-teams)
2. [Installation & Quick Start](#2-installation--quick-start)
3. [Multi-Model Chat](#3-multi-model-chat)
4. [Agent Autopilot](#4-agent-autopilot-1)
5. [Harness Autonomous Execution](#5-harness-autonomous-execution)
6. [Grind Mode](#6-grind-mode)
7. [Team Mode](#7-team-mode)
8. [Whiteboard Logic Chain](#8-whiteboard-logic-chain)
9. [MCP Toolbox](#9-mcp-toolbox)
10. [Expert Packs](#10-expert-packs)
11. [Workflow Templates](#11-workflow-templates)
12. [Knowledge Base & Sparks](#12-knowledge-base--sparks)
13. [Code Review](#13-code-review)
14. [Voice Input](#14-voice-input)
15. [Screenshot to Code](#15-screenshot-to-code)
16. [Scheduled Tasks](#16-scheduled-tasks)
17. [Settings & Customization](#17-settings--customization)

---

### 1. What is SLATE Teams?

SLATE Teams is a **local-first** AI collaboration studio. It integrates mainstream LLMs, 35 built-in tools, team debates, DAG workflows, whiteboard logic chains — all in a lightweight interface. Zero npm, zero build, ready to use.

Core philosophy: **Let ideas go straight to action, without tool friction in between.**

---

### 2. Installation & Quick Start

#### Option A: Installer (Recommended)

Download `SLATE-Teams-Setup-x.x.x.exe` from [GitHub Releases](https://github.com/CaryWang1234/SLATE-Teams/releases) and run the installer.

On Windows, clicking X does not quit the app: SLATE Teams hides into the notification area and keeps serving, so the turn that is generating finishes and LAN clients stay connected. Double-click the tray icon (or right-click → "Show window") to bring the window back; only "Quit SLATE Teams" actually exits. The first time it hides, a balloon tells you where it went. The tray is implemented with Windows native APIs only, adding no third-party dependency; off Windows, or in a logon session with no notification area, closing the window exits exactly as before.

One install opens exactly one SLATE Teams window: if the window is already open, or already hidden in the notification area, launching again adds no second window and starts no second backend — the new process brings the running window to the front (flashing its taskbar icon when Windows refuses the foreground) and then exits. The lock disappears with the process, so a crash or a kill in Task Manager never leaves the app "unable to open again"; a copy installed into a different folder counts as a different install and may run alongside this one.

#### macOS

Download `SLATE-Teams-Setup-x.x.x.dmg` from [GitHub Releases](https://github.com/CaryWang1234/SLATE-Teams/releases), mount it, and drag "SLATE Teams" into "Applications". The `.dmg` comes straight out of CI and is ad-hoc signed but not notarised, so Gatekeeper stops the first launch once: right-click (or long-press) the icon in Finder → Open → Open again. A plain double-click works from then on. If the dialog instead reads "「SLATE Teams」已损坏，无法打开" (only a "Move to Trash" button, no "Open"), the signature was not picked up — clear the quarantine flag first: `sudo xattr -dr com.apple.quarantine "/Applications/SLATE Teams.app"`.

An installed build keeps its data outside the `.app`, under `~/Library/Application Support/SLATE Teams`: chat history, API keys, the backend log and the WebView profile all live there. Replacing the `.app` to upgrade therefore leaves your data alone, and the bundle is never written to at runtime — the kind of change that would void a signature once the app is signed. Running from source still uses `data/` inside the repo.

The window renders through macOS-native WKWebView while Windows uses Edge WebView2; the two engines keep their own preferences and caches apart. "Check for Updates" under Settings → About hands you the `.dmg` link for this platform rather than an `.exe` you cannot open, and falls back to the Releases page when no matching asset is published.

`⌘ + N` starts a new chat and `⌘ + D` toggles light/dark; the `Ctrl` chords keep working too. With focus inside the whiteboard canvas, `⌘ + D` belongs to its duplicate-selected-cards binding and does not flip the theme. The UI text uses the system font (PingFang SC) and code uses SF Mono / Menlo, where Windows stays on Microsoft YaHei and Consolas.

The dangerous-command list is now platform-aware: `diskutil erase`, `diskutil reformat`, `diskutil partitionDisk` and `diskutil secureErase` ask for approval first, while catastrophic ones — `rm -rf /`, `rm -rf ~`, `mkfs`, `dd if=` — are refused outright, approval or not.

Two things Mac does not have yet: the notification-area residency and the "one install, one window" gate are Windows-only, so closing the window quits and launching again starts a second copy. Also note that this round of macOS work was verified on Windows by passing the platform in as an argument and asserting the Darwin branches — the `.app` and `.dmg` have not been run on real hardware.

#### Option B: From Source

```bash
git clone https://github.com/CaryWang1234/SLATE-Teams.git
cd SLATE-Teams
pip install -r requirements.txt
python desktop.py
```

After starting from source, visit `http://127.0.0.1:8000`.

#### First-Time Setup

1. Click the **Settings** tab in the top bar
2. Add your API Key in the Models section (OpenAI / Claude / Gemini / DeepSeek / custom endpoints)
3. Select a default model and start chatting

---

### 3. Multi-Model Chat

SLATE Teams supports multiple models simultaneously — switch anytime from the top dropdown.

**Key Points:**
- Click the model dropdown → Add/switch models
- Different conversations can use different models
- Supports local models (Ollama / LM Studio via OpenAI-compatible endpoints)
- A brand mark sits beside the model name: built-ins and models you add are matched by name; recognised ones are drawn in the brand's own colours (neutral monochrome where no colour original exists), and an unknown one draws nothing instead of wearing another vendor's logo. A custom theme won't recolour them
- Each reply shows model name and token usage

**Task list on the left:**
- Sort is yours to pick: recent / by project / by status / created / by usage. The preference syncs across devices, and the classic sidebar and the Codex history rail share the same one
- Each conversation carries a mark matching where it stands: **needs action** (you stopped it, or a next step remains), **error** (request failed / stream cut), **running** (breathing animation, only while this run is actually generating), **done but unread** (cleared the moment you open it)
- The mark records how the last run ended: if the conversation was continued elsewhere (e.g. phone remote), the stale mark retires itself

**Task list rail on the right:**
- Large tasks stream their checklist into the rail beside the messages; the "Task list" button on the chat header (the quick-action row above the input in the Codex layout) folds the whole rail and hands the width back, one more click unfolds it
- Folding is a preference stored on this machine: it survives reload and restart, and a list still making progress will not force the rail back open
- While folded the button tooltip keeps reporting `{done}/{total}`, so progress does not vanish entirely; with no checklist in this conversation the button greys out

**"Polish prompt" (the ✦ left of the mic):**
- Half-way through a sentence and it isn't landing? One click hands the draft to the current model for a rewrite
- The rewrite is compared against the original in a dialog first — only **Use it** writes it back
- **Keep original**, `Esc` or clicking outside all decline it; the input box does not change by a single character
- If the draft changes while you wait (voice dictation included), that rewrite is dropped instead of overwriting what you typed
- Which model does it is pinned under Settings → AI Assistance → Prompt polish; switch it off and it never sends a request

**Shortcuts:**
- `Enter` to send
- `Shift + Enter` for newline
- `Ctrl + N` (`⌘ + N` on Mac) for a new conversation
- `Ctrl + D` (`⌘ + D` on Mac) for light/dark; inside the whiteboard canvas that chord belongs to the board

---

### 4. Agent Autopilot

Autopilot is the default "do not make me type continue" execution layer. When your message clearly asks SLATE Teams to inspect a project, edit files, run commands, debug, commit, or generate files, it automatically enters a multi-round Agent Loop.

**How to use it:**
- Say things like "fix xxx", "scan the project for bugs", "optimize tool calling", or "run tests and fix failures"
- You do not need to enable Harness manually, and you do not need to keep sending "continue"
- Ordinary tasks can auto-advance up to 24 rounds; broad project-wide or multi-file tasks can auto-advance up to 40 rounds
- The round budget is a stop-loss, not a target: once every deliverable is verified the model calls `exit_autopilot` to close the loop
- Out of rounds is not the same as done: **Continue Autopilot** (on by default) refuses to let go at the last round. If that round was still executing tools, the ceiling moves back by 8 rounds (at most 3 top-ups) so the work in flight can finish; if the model stopped without doing anything, the open TODOLIST items are read back to it and it is told to keep going or write 【任务完成】 explicitly. Don't want it? Uncheck it under Settings → Auto-Advance
- Once those top-ups are spent too and the loop really dismisses, the system presses "继续跑完" for you — at most 2 auto-resumes per conversation, each announced so you can see it wasn't your click, and the resumed run closes through the normal completion channel. It waits until that conversation is actually idle (post-round compression or memory work can still be holding it) and never steals the screen of another conversation. Two cases keep it hands-off: this conversation is on the Manual approval tier (every step needs a human nod), or Auto-Advance is switched off — then the resume bar just stays on screen for you

**What it does automatically:**
1. Reads relevant directories, files, config, or Git state
2. Calls tools such as `file_edit`, `terminal`, `git_tool`, or `code_scan`
3. Feeds tool results back into the model invisibly so it can continue
4. Re-reads files or runs checks/tests/builds after changes
5. If the model claims completion without tool evidence, SLATE Teams asks it to verify or actually act first
6. When the round budget runs out while work is still open, Continue Autopilot tops up the rounds and keeps going (toggle it off under Settings → Auto-Advance)

**InkStream — arguments as they are written:** while the model streams a tool call token by token, SLATE Teams parses the half-formed arguments against the local tool schema and shows a live one-line preview of which fields are already closed and which one is still being written. It is preview only — **incomplete arguments never reach execution**; multi-KB text fields fold into line and character counts instead of flooding the screen.

**Stop really cancels:** pressing Stop closes both the model stream and the tool-call stream, so the backend terminates the matching subprocess or running task instead of "UI stopped, work still going". Cancelled calls are recorded in the local event ledger under their own status, kept apart from successful ones.

**A truncated answer says so:** thinking and the body share one output ceiling, so a long think can leave no room to write. That ending is no longer swallowed: when the stream produced content and then ended naturally with neither a closing marker nor a finish reason, the round is flagged and reported as it closes, with the cause kept apart (thinking consumed the whole output budget / upstream cut the stream early) and the same clickable "Continue" entry; a reply that did produce text but stopped early is labelled possibly incomplete. This notice is given in every mode, not only under Auto-Advance.

**What this round wrote is shown when it stops:** once the round has really written to disk (edit / create / append), the end of the last message carries a card — which files changed, added and removed lines per file, expandable into per-file diffs. "Revert" restores every file the round touched to its state before the round and deletes what the round created, behind a red confirmation step; files you edited yourself afterwards are skipped and reported, never overwritten by a revert. Originals live in `data/round_snapshots/` for 7 days, files over 2MB are never stored (they are skipped with the reason stated), and nothing leaves the machine. On mobile the list is read-only — reverting stays on the desktop.

**When to use Harness:** use the **Target Mode** toggle in the **＋** menu (left of the chat input) when you want the stronger six-phase mode, explicit TODOLIST enforcement, and an 80-round long-task loop; after verification passes the model closes it with `exit_target_mode`, which also switches Target Mode off.

---

### 5. Harness Autonomous Execution

Harness is SLATE Teams's "autopilot" — state your goal, and the model autonomously plans, calls tools, and executes in multiple rounds until done.

**Launch:**
- Click 🚀 button in the top bar
- Or mention "use Harness" in your message

**Six-Phase Flow:**
1. **Goal Understanding** → Parse your requirements
2. **Plan Creation** → Break into executable steps
3. **Tool Execution** → Autonomously call files/terminal/search tools
4. **Verification** → Confirm each step's result
5. **Report** → Output execution summary
6. **Trace** → Log to TODOLIST

**Features:**
- Up to 80 autonomous rounds, closed by the model calling `exit_target_mode` once verification passes
- Pause anytime (only interrupts current round, no progress loss)
- Auto-creates TODOLIST for large tasks (shown live in the right rail; the "Task list" button on the chat header folds or unfolds it anytime, and keeps reporting `{done}/{total}` while folded)
- Auto-recovery from exceptions

---

### 6. Grind Mode

Interactive refinement: turn rough ideas into structured task briefs.

**Launch:**
- Type `/grind your idea`
- Or click 🖌 button
- **New:** Auto-suggests when detecting abstract tasks (e.g., "make a website")

**Three-Phase Flow:**

| Phase | Description |
|-------|-------------|
| Receive | AI restates your idea, lists 3-5 gaps, asks only the first |
| Grind | Round-by-round questions, one at a time, prefers A/B choices (up to 10 rounds) |
| Collect | Outputs structured JSON brief with goals/deliverables/acceptance criteria |

**Trigger Collect:** Type "收墨" / "够了" / "就这样" or reach round limit

**Three Actions on Draft:**
- Send to Harness → Execute directly
- Push to Whiteboard → Visual reasoning
- Save as Template → Reuse later

---

### 7. Team Mode

Multiple AI roles debate your question across rounds, producing a consensus conclusion.

**Launch:** Click "Team" tab in the top bar

**Flow:**
1. Select team members (9 presets or custom)
2. Enter your question
3. Members speak in role order (3 debate rounds)
4. Consensus summary output

**Custom Teams:**
- Settings → Team Management → Add/Edit/Delete members
- Each member can specify model, role, and persona

**Discussion record:** every turn is stored besides the local history — a team session, its roster,
and one event-ledger run per member — which is exactly what the Whiteboard → Workflow star map reads.
If the write fails, the local history stays and that session is labelled "Local only".

---

### 8. Whiteboard Logic Chain

Visual cards + connections system for reasoning and planning.

**Operations:**
- Click "Whiteboard" tab to enter
- AI auto-creates cards (analysis results, comparisons)
- Drag cards, create connections manually
- Switch display modes from the whiteboard header: Git, Flow, Kanban, Outline and Workflow. The main whiteboard is the default freeform canvas.
- Git Tree recognizes the opened project's Git elements: HEAD, branches, remote branches, commits, tags, remotes, worktrees, stash, staged/changed/untracked counts, and unpushed commits. Nodes and the canvas viewport are draggable.
- 4 AI whiteboard tools:
  - `card_create` — Create cards
  - `card_edit` — Edit cards
  - `arrow_create` — Create connections
  - `board_summarize` — Summarize the board

**The 5th mode, "Workflow": how to run it and how it's going, on one screen**
- Run bar: stop / resume / autopilot (goal mode) / response mode / reasoning effort.
  These controls don't keep a second copy of the state — they write the very state the chat
  header uses, so the two can never disagree.
- Flow wall: every playbook in `data/actions/*.yml` becomes a card stating its step count,
  inputs, author and where the output lands. "Run this" sends it into the current chat as an
  @mention; "Steps" expands the step list in place (fetched lazily).
- Pinning and "Pinned only" live in `slate_board_wf_prefs` on this machine and only reorder this view.
- Current run: projected straight from the event ledger — which step is live, how long it has taken,
  whether it succeeded. The live layer only patches text in its own subtree, so a per-second tick
  never re-renders the board underneath it.
- Team star map: the most recent team discussion of this conversation, laid out by role, showing who
  replied to whom, which tools each member used and which sub-agents they spawned — all from real
  backend records. With no team record it says so instead of drawing a decorative graph.

---

### 9. MCP Toolbox

SLATE Teams includes 35 built-in MCP tools. The model decides when to use them during conversations.

**Usage:**
- Describe your need naturally (e.g., "search for xxx")
- Or explicitly call `@tool_name`

**Tool Categories:**

| Category | Tools |
|----------|-------|
| File Ops | `file_tree` `file_peek` `file_create` `file_edit` `file_append` |
| Terminal | `terminal` (sandbox execution, high-risk commands need approval) `bg_task` (background task: returns at once, wakes the model when it ends) |
| Search & Code | `code_search` `code_scan` `doc_scan` `repo_stats` `todo_scan` `python_api_extract` |
| Doc Gen | `doc_write` `ppt_create` `word_create` `html_render` `html_bundle` |
| Office & PDF | `excel_tool` `pdf_tool` |
| Data | `json_tool` `regex_test` `text_summarize` `chart_create` `qrcode_create` |
| Web | `web_search` `web_fetch` |
| System & Environment | `system_info` `git_tool` `css_color` |
| Automation | `browser_automation` `computer_use` `screenshot_to_code` |
| AI Generation | `image_gen` `video_gen` (model and API key configured in Settings) |
| Extension | `mcp_factory` (tool factory — generated tools live in `data/evolved/`, disable / roll back / revoke under Extensions → New features) |

**Unicode and encoding:**
- `file_peek` / `file_edit` auto-detect UTF-8, UTF-8 BOM, GB18030, GBK, UTF-16, and other common text encodings
- Chinese, emoji, and full-width symbols are preserved as-is; if a legacy encoding cannot represent a new character, the tool safely upgrades the write encoding instead of losing text
- On Windows, `terminal` hides PowerShell windows and captures Unicode-safe output for native commands such as Python / Node / Git / npm / rg
- On Windows `terminal` runs one PowerShell process per command: multi-line blocks (`foreach` / `if`) execute directly, `&&` / `||` are rewritten into `if ($?)` nesting on PowerShell 5.1, and a syntax error comes back verbatim with a failing exit code. The session keeps `cd` and `$env:` (PowerShell variables do not cross commands), and interactive REPLs such as bare `python` / `node` exit at once instead of holding the task open

**Two kinds of background work:**

- `bg_task`: hand the slow terminal jobs (servers, compiles, training, long test suites) over — `action=start` returns at once so the model does not have to sit and watch, and when the task ends (or matches the regex you gave) the system wakes it with an output tail. The task lives in the SLATE Teams backend process; logs land in `data/bg_tasks/`
- `subagent_run` with `background=true`: a parallel subagent batch can go background too — the model takes a task id and carries on, and when the batch finishes every conclusion arrives through that same background-task message channel (one wake path, one badge system, shared with terminal tasks). The difference is lifetime: a batch lives in the browser page, so reloading or closing the tab ends it
- Both kinds share one list in the right-rail Background Tasks panel — state, output / conclusions, and the stop button all live there; at most 3 subagent batches run at once

**Action Playbooks:**

The tools above are the hands; an Action is the agreed sequence — write the required flow for a recurring task into one yml file so the model follows it instead of re-guessing every time.

- Location: `data/actions/<id>.yml`, one flow per file; the filename (minus `.yml`) is its id
- Fields: `name`, `description`, `when` (when it applies), `inputs` (what to ask the user for), `steps` (each with `title` plus optional `tool` / `detail` / `check`), `output`, `tags`
- In Agent mode the model sees the Action catalog automatically (capped at 20 entries; the remainder is reported as a count pointing to `actions_list`), reads a full flow with `actions_read` before committing to it, then executes the steps. Chat mode has no tools, so the catalog is not injected at all
- Reading a flow is not the same as running it: steps that name a suggested tool still require the actual call, and the model never claims completion just because it read the yml
- A broken file does not silently disappear: the Actions column on the top-level Extensions page lists it together with "line N: reason", and tool results tell the model which Actions are currently unavailable
- The format is a minimal YAML subset (2-space indent, block arrays, `|` literal blocks); tabs, anchors and multi-document files are rejected. 64 KB per file
- Editable in the panel: the Actions column on the top-level Extensions page, then "+ New Action" or click an entry to open the editor. Validation runs as you type and reports "line N: reason"; a failing draft cannot be saved
- Every overwrite or delete first copies the previous text to `data/actions/.history/` (up to 5 versions per Action). The editor's "History" button lets you view any version or roll back to it
- The model can write too: the `actions_write` tool requires it to declare `author: model` inside the yml (the panel badges such files "Model-written"), and in "Ask" permission mode a confirmation dialog shows the exact content first. "Auto" / "Full access" skip the dialog — a bad write is reversible via history, but the format gate never lets an invalid file through
- Typing `@<id>` in the chat box injects the whole flow into that message, capped at 6000 characters; anything longer is trimmed with a note telling the model to read the rest with `actions_read`

**Self-evolving tools (tool factory):**

`mcp_factory` lets SLATE Teams write the tools it is missing and use them itself. Every product lands in `data/evolved/` (the user data area), two files per tool: `<name>.py` holds the generated code, `<name>.json` the description and parameters.

- Why not `backend/skills/`: that is the program's own source tree — one upgrade would wipe everything you had accumulated, and a running program has no business editing itself. `data/` is never overwritten by an upgrade, and the manifests are read again on every restart
- Managed under the top **Extensions** tab → **New features** column. Each entry states its state: working / disabled / broken (with the line of the syntax error) / shadowed by a built-in tool of the same name
- Disabling removes the tool from the model's toolbox entirely, rather than failing when it is called; re-enabling is one click
- Overwrite, revoke and rollback each take a backup into `data/evolved/.history/` (up to 5 versions per tool). The entry dialog's "History" lists every version, lets you read one and roll back to it — and a version that no longer compiles is never written back
- Code that does not compile never reaches the disk (the check compiles, it never executes on your behalf); a request to create a tool named after a built-in one is refused on the spot
- Built-ins win on a name clash: if an upgrade ships a built-in tool with the same name, your generated copy is shadowed and labelled — visible, revocable, no fight with the new version
- Products left in `backend/skills/` by older versions are copied into `data/evolved/` at startup (copied, never deleted from the program's own directory)
- `@` mentions and `skill_search` both find these tools, and the system prompt names the currently enabled self-produced ones

---

### 10. Expert Packs

Pre-built role knowledge packages that let AI answer as a specific expert.

**Usage:**
- Select from the "Expert" dropdown on the left side of chat
- Built-in sample: Creative Writing Mentor

**Import/Export:**
- Settings → Expert Pack Management → Import `.zip` / Export as `.zip`
- Pack structure: `persona.md` + `rules.md` + `knowledge/` + `skills/`

**Create Custom Expert:**
1. Create a folder with the above structure
2. Zip and import
3. Or create directly via UI

---

### 11. Workflow Templates

Pre-defined DAG workflows for complex multi-node parallel execution.

**8 Built-in Templates:**

| Template | Purpose |
|----------|---------|
| Default Dev Flow | General development tasks |
| Parallel Research | Multi-dimensional parallel research |
| Bug Investigation | Parallel log/code/env analysis |
| Code Review | Parallel quality/security/performance review |
| Data Analysis | Parallel trend/anomaly/stats analysis |
| Doc Generation | Outline → Content → Summary → Integration |
| Product Requirements | Idea → User stories → Features → PRD |
| Research Report | Topic → Research → Comparison → Report |

**Management:**
- Team Panel → Workflows → Import/Export/Delete custom templates

---

### 12. Knowledge Base & Sparks

**Knowledge Base:** Long-term project knowledge storage, auto-injected into conversations.

- Settings → Memory & Canvas → Knowledge tab
- Manually add notes, project background, reference material
- Supports Markdown

**Sparks:** Auto-captures valuable technical insights when conversations end.

- After conversation → System detects archivable insights
- Confirms and stores to knowledge base
- No manual operation needed

---

### 13. Code Review

AI-powered four-dimensional structured review of Git repository changes.

**Usage:**
- Settings → Code Review
- Select repository path
- AI reads `git diff` → Analyzes quality/security/performance/maintainability
- Outputs line-level comments + summary report

---

### 14. Voice Input

Browser-based speech-to-text for hands-free input.

**Usage:**
- Click 🎤 button next to the input box
- Speak your idea, real-time transcription appears in input
- Click again to stop
- Auto-detects Chinese and English

**Note:** Requires Web Speech API support (Chrome / Edge supported)

---

### 15. Screenshot to Code

Convert screenshots to HTML/CSS code.

**Usage:**
- Describe "convert this screenshot to code" in chat
- Or `@screenshot_to_code` with image path
- AI vision model analyzes image → Generates corresponding HTML/CSS

**Supported formats:** PNG / JPG / JPEG / GIF / WebP / BMP / SVG (≤10MB)

---

### 16. Scheduled Tasks

Let AI automatically execute tasks on schedule or by events.

**Usage:**
- Click ⏰ button in top bar
- New Task → Set name, trigger (schedule/event), execution content
- Supports Cron expressions

**Trigger Types:**
- Schedule: Every N minutes/hours/days
- Event: File changes, conversation end, etc.

---

### 17. Settings & Customization

**Main Settings:**

| Setting | Description |
|---------|-------------|
| Model Management | Add/remove API keys, configure custom endpoints, optionally enable Responses API |
| Reasoning Effort | Click the pill left of the input to open a slider; levels follow the model's capability (auto/off/low/medium/high), each tick annotated with its ink shade in small type (free/clear/light/rich/charred). Nine capability classes decide what appears: a model that forces reasoning has no "off", on/off-only endpoints say "low/medium/high are all treated as on", a tick the model cannot take is greyed out with the reason, and a 400 naming the field causes one retry with it stripped. The value is persisted only when you let go |
| Context Budget | Per-model "max context" = a slider whose ticks are generated from that model's own window, plus an exact number box and a "probe window" button. Auto now takes this model's nominal window × 0.8 with no snapping to shared ticks (an 8K local model gets 6553 instead of eating the whole window with no room for the reply); the box keeps whatever you type (131072 stays 131072, clamped only inside 1K–4M); local/custom endpoints can be probed for their real window (Ollama / llama.cpp / vLLM / OpenAI-compatible), stored as a separate override you can clear with one click. The same value drives both the auto-compress threshold and the usage bar |
| Output Control | Max tokens, streaming toggle |
| Auto-Advance | Autopilot / short-reply review / long-stall review / Continue Autopilot (last-round top-up, plus auto-resume when the rounds run out — it only steps in on tiers other than Manual approval) |
| Safety Mode | Four tiers you can set per conversation: Manual / Auto (24 high-risk rules only) / Full Access (no approval prompts, the AI still asks one clarifying question, pill turns red) / Night Mode (fully unattended, pill turns night-purple). Below Night Mode sits a "keep this machine awake during night runs" checkbox: it blocks system sleep only — the display still blanks, closing the lid or sleeping by hand still win, and an already-asleep machine cannot be woken; the lease is held for as long as that run is live and lapses within 60 seconds if the page dies. The desktop window holds it — tasks running on the phone page, scheduled tasks with no front-end run and background terminal tasks do not. Windows only in this version |
| Reply Modes | The mode pill at the left of the input bar ships four built-in tiers, each with its own icon and colour: Smart (every tool, prompt and knobs untouched — the default) / Chat (no tools, single-turn answer) / Eco (read-only tool whitelist + low reasoning effort + a tighter round cap) / Turbo (all tools + high reasoning + a looser round cap); switching changes only this conversation, each session keeps its own and a new one starts from the default. The default and any custom modes are created and managed under Extensions → Modes; the model can mint modes itself through `mode_write` (create / update / delete with an appended prompt, a tool whitelist, a reasoning effort and a round cap), shown to you in a dialog under Manual approval. The whitelist genuinely blocks — an unopened tool is dropped from the native tools schema and the text catalogue alike, and a model calling it from memory is stopped at the execute gate with a note that the mode does not allow it |
| LAN Remote | View LAN URL / QR code, configure remote access password |
| Theme | Dark/Light toggle (top-bar button and Ctrl+D); while a custom theme is active the button locks and clicking it explains why nothing changed |
| Custom Theme | Four source colours (background / panel / body text / accent) derive the whole palette, plus body and code fonts (you can import your own font files), a panel-opacity slider, and a local background image with an opacity slider; it can also pull the preview of the wallpaper Wallpaper Engine is currently using (read-only — it never launches or reconfigures that app, and a new wallpaper there does not follow over until you click again); 10 presets, editing any swatch drops the preset highlight, the on/off switch syncs across devices while images and fonts stay on this machine |
| Session Archive | Every row in the Tasks rail offers Archive on hover — archiving only takes the conversation out of the list, it is not deletion; a conversation that is still generating is blocked with a reason. Archived conversations appear in this settings group, each restorable (back to the Tasks rail) or deletable after a confirmation that also clears its messages |
| Language | Chinese / English — beyond buttons and section labels, input placeholders and hover titles go through the dictionary too; nothing the user or the model wrote is ever rewritten, and the brand mark 席 opts out via `data-i18n-skip` |
| Context Compression | Auto/manual compression of history; the model still receives the summary in full, the transcript folds it into an expandable strip. System nudges and tool-result feeds stay context-only — rebuilding the retained tail after compression never paints them as bubbles |
| AI Assistance | 15 token-spending features outside the chat loop, each with its own switch and optional pinned model (including the auto session title: after a new conversation's first exchange the model proposes a short title, and only placeholder titles — the "first 30 characters of the opening message" kind — get replaced); off means no request at all, and the three tool-driven ones also disappear from the tool catalogue |
| Tasks & Projects | Whether a run keeps going when you switch away (off restores the old "switch means stop"), how many runs may go at once (1-4), and how many within one project (1-3, serial by default); queued sends are visible both in the right-hand task centre and above the input box |

---

<p align="center">
  <strong>SLATE Teams</strong>—— 将灵感转化为结构化方案<br>
  <strong>SLATE Teams</strong> — Turn inspiration into structured action
</p>
