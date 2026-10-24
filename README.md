<div align="center">

<img src="frontend/icon.png" width="96" alt="SLATE Teams" />

# SLATE Teams

**Local AI Collaboration Studio — Turn Sparks of Ideas into Structured Plans**

*SLATE Teams — Grind inspiration into polished deliverables.*

[![License: MIT](https://img.shields.io/badge/License-MIT-1a1a1a.svg)](LICENSE)
[![Website](https://img.shields.io/badge/Website-teams.slate--ai.site-1a1a1a.svg)](https://teams.slate-ai.site/)
[![Docs](https://img.shields.io/badge/Docs-docs.teams.slate--ai.site-1a1a1a.svg)](https://docs.teams.slate-ai.site/)
[![Guide](https://img.shields.io/badge/Guide-User%20Tutorial-97342A.svg)](https://teams.slate-ai.site/guide.html)
[![Python](https://img.shields.io/badge/Python-3.13%2B-1a1a1a.svg)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-1a1a1a.svg)]()
[![Build](https://img.shields.io/badge/Build-Zero%20npm%20%2F%20Zero%20Bundler-1a1a1a.svg)]()

**English** · [中文](README-zh.md)

</div>

---

SLATE Teams is a **lightweight local AI collaboration tool** focused on prompt engineering, context management, and project ideation.

It features multi-model chat, Agent Autopilot, MCP tool calling, Target Mode autonomous execution, Grind Mode, AI team debates, and a whiteboard-style logic chain. It can either drive built-in tools to complete tasks directly, or generate high-quality prompts for external Coding Agents (Claude Code, Codex, Cursor, etc.).

**Zero npm dependencies. Zero build tools. Native tech stack. Local-first.**

---

## ✨ Highlights

- 🗣️ **Unified Multi-Model Access** — Major LLMs worldwide + custom OpenAI-compatible endpoints + local models (Ollama / LM Studio)
- ⚡ **Agent Autopilot + Target Mode** — Ordinary project requests now auto-run in an Agent loop without needing repeated "continue" prompts; Target Mode remains the explicit six-phase, 80-round closed-loop mode for large tasks
- 🎚️ **Per-model context budget, and only the effort an endpoint accepts** — Every model row in Settings carries a "max context" control whose ticks are generated from that model's own window: "auto" now takes its nominal window × 0.8 with no snapping to shared ticks, so a local model with an 8K window gets 6553 instead of filling the window and leaving no room for the reply; the number box keeps exactly what you type (131072 stays 131072), and local or custom endpoints can be probed for their real window, with one click to undo it. That same value is both the auto-compaction threshold and the usage-bar denominator, so the two can never drift apart. Thinking effort is split into nine endpoint capability classes covering Kimi / Qwen / GLM / Doubao / MiniMax / ERNIE / Ollama and custom endpoints: models that force reasoning get no "off" tick, on/off models are labelled "low/medium/high are all treated as on", unsupported ticks are greyed out with the reason, and a 400 naming the field causes one retry with it stripped — the level may not apply, but the model stays usable
- ✒️ **InkStream — arguments as they are written** — While the model streams a tool call token by token, SLATE Teams parses the half-formed JSON against the local schema and shows which fields are closed and which is still being written; preview only — incomplete arguments never reach execution, and long body fields collapse to line/char counts
- 🛑 **Stop really cancels** — Pressing Stop closes both the LLM stream and the tool-call stream, so the backend terminates the running subprocess or task instead of "UI stopped, work still going"; cancelled calls are recorded as their own status in the event ledger
- 📣 **A truncated answer says so** — When a stream ends naturally but carries neither `[DONE]` nor a `finish_reason`, the round is flagged and reported in every mode, with the cause kept apart (thinking consumed the whole output budget vs upstream cut the stream early); a reply that produced text but stopped early is labelled possibly incomplete and offers the same one-click "Continue". Both the notice and the resume path used to hang off Autopilot/target mode, so with them off a stalled round produced no signal at all
- ↩️ **This round's file changes, revertible** — When a round actually wrote to disk, the last message ends with a card: which files changed and their added/removed lines, expandable into per-file diffs. "Revert" restores every file the round touched to its pre-round state (files it created are deleted) behind a red confirmation; files you edited afterwards are skipped and reported instead of being overwritten. Originals live in `data/round_snapshots/` for 7 days, files over 2MB are never stored, and nothing leaves the machine
- 🖌️ **Grind Mode** — `/grind` a rough idea, AI refines it through three-phase questioning into a structured task brief, one-click send to Target Mode
- 🗂️ **Chat & Data Management** — Full-text search, export/rename/batch-manage sessions, edit/delete messages, one-click backup/restore, storage usage visualization
- 🛠️ **35 Built-in MCP Tools** — File read/write/edit/append, project-wide code search, Unicode-safe terminal, background terminal tasks (start and walk away, get woken when they end), PPT/Word/Excel/PDF tools, SVG charts & QR codes, Python API doc extraction, portable web bundling, code & document security scanning, read-only git info, web search & page scraping, MCP Factory for self-production, screenshot-to-code, AI image & video generation, browser & desktop automation
- 🧩 **Custom Skill System** — `SKILL.md` plug-and-play, `@` mention in chat to inject context
- 📋 **Action Playbooks** — Capture the required flow for a recurring task in `data/actions/<id>.yml`; the model sees the catalog and reads a playbook in full before following it. Editable in Settings, model-writable behind an approval gate, every overwrite backed up for one-click rollback
- 🎓 **Expert Packs** — Persona + rules + knowledge + skills in a zip, importable/exportable, injectable via chat dropdown / team cards / @mention
- 📖 **Better Project Understanding** — Three scan levels (brief/balanced/detailed) auto-generate project guide & rulebook
- 🗂️ **Workspace projects** — one project can hold several unrelated folders; exactly one is the active root at a time (files, Git and the terminal all follow it), switch with one click in the sidebar
- 📜 **Per-project constitution** — project rules can live in that project's own `.slate/config.json`; settings and the Prompt Factory say which document you are editing, falling back to the global one when a project has none
- 🛰️ **Runs across projects** — switching projects no longer kills the generation you left behind: it keeps streaming in the background and reports into the task centre. One project stays serial by default, up to 2 (1-4) projects may run at once, and a send that finds no slot is queued and labelled "queued" rather than dropped. Tokens are booked per conversation, so the meter only ever shows the one on screen
- ⏳ **Subagents can go background** — when the model dispatches a parallel batch it may choose "background": it gets a task id and keeps working, and when the batch finishes every subagent's conclusion comes back as a background-task message that wakes the model. The right-rail Background Tasks panel shows both kinds (terminal tasks and subagent batches) and lets you read the conclusions or stop the batch on the spot. Up to 3 batches at a time; a batch lives inside the browser page, so reloading or closing the tab ends it (a `bg_task` lives in the backend process instead)
- 🎯 **Per-project overrides (Actions / Knowledge / MCP)** — the same "global + project override" idea as the per-project constitution, now for three more things: an Action can have a same-named copy in that project's `.slate/actions/<id>.yml` that supersedes the global one; knowledge documents carry their scope, so the project's same-titled document wins while every other global document stays visible (walking into a project no longer erases what you saved); and an MCP server can be switched off — or limited to a few tools — for one project only. That mask is all the project's `.slate/config.json` stores: URLs and secrets never leave the global config or enter your repository. Lists badge which entry is the project's copy, editors say which document you are editing, and removing an override falls back to the global one
- 🔍 **Code Review** — Read git diff (staged/unstaged/commit range), AI reviews across code quality, security, performance, and maintainability with structured report and line-level comments
- 🔔 **Task Completion Notifications** — Chime sound + system notification when Harness/team/workflow finishes; both toggleable in settings
- 📡 **LAN Remote Control — Auth + Switch** — Opens port 8001 on launch; phone/tablet browsers auto-switch to the dedicated **SLATE Teams Mobile UI** — bottom-tab navigation across Chat / Conversations / Memory / Tasks / Settings, full chat & tool-loop capability, bottom-sheet confirmations for high-risk commands and file diffs, desktop zero-regression. The address carries an auth token and untokenised LAN requests are refused; Settings has a switch to turn it off at any time — turning it off really releases the listening port, it does not merely hide the address. On a machine with no desktop (a Linux server, say) run `SLATE-Teams --remote` to serve the remote UI with no window and print the authorised address to the terminal
- 🖱️ **Closing the Window Doesn't Stop It (Windows tray)** — The X button no longer quits the app: the window drops into the notification area and the backend keeps serving (the turn that is generating finishes, and phones stay connected on the LAN). Double-click the tray icon or pick "Show window" to get it back; only "Quit SLATE Teams" actually exits, and the first time it hides you get a balloon telling you where it went. The tray is built on Windows native APIs only — no third-party tray dependency; off Windows, or in a session with no notification area, closing the window exits exactly as before
- 🔒 **One Window Per Install** — If the window is already open (or hidden in the notification area), double-clicking the icon again adds no second window and starts no second backend: the new process brings the running window to the front and exits. The lock disappears with the process, so a crash or a kill in Task Manager never leaves the app "unable to open again"
- 🍎 **Mac gets its own footing** — The installed build keeps its data in `~/Library/Application Support/SLATE Teams` (an upgrade replaces the whole `.app`, so data living inside the bundle means your API keys and chat history leave with the next drag), with the log and the browser profile in the same place; the webview renderer is picked per platform (WebView2 on Windows, WKWebView on macOS); an update check hands you the `.dmg` instead of the Windows installer; `⌘N` / `⌘D` work alongside Ctrl, so the "Ctrl+N" written in the UI stays true on both; the default font stacks resolve to PingFang SC and Menlo/SF Mono on Mac with Windows left pixel-identical; `diskutil eraseDisk`-class commands ask first and `rm -rf ~` is blocked at every tier. The tray and the one-window gate are still Windows-only — on Mac, closing the window quits. **These Mac changes were verified on Windows: pure functions run with the platform string injected, the UI walked in a real browser — the `.app` itself has never been opened on real hardware**, so questions like whether the macOS app menu grabs `⌘N` first can only be answered by a Mac
- 🛡️ **Approval Modes (per conversation)** — four tiers: Manual asks before every command and every network call; Auto asks only when one of 24 hardcoded high-risk rules matches; **Full Access** skips approvals entirely but the AI still asks a clarifying question when it genuinely lacks one (the pill renders red); **Night Mode** goes one step further and never pauses on a question either — it picks an option and keeps going (the pill renders purple). The settings page holds the default for new conversations, and the approval pill in the input bar changes it for that conversation alone. The AI explains a command's purpose before you approve, and catastrophic commands (`rm -rf /`, `format`, etc.) are blocked in every mode. Night Mode can additionally keep the machine awake while a task runs (switch on the settings page): it blocks system sleep only — the display still blanks, closing the lid or sleeping by hand still win, and a machine that is already asleep cannot be woken. The lease is renewed by a heartbeat from the page, so a refresh or a crash hands the power policy back within 60 seconds. The desktop window holds it — tasks running on the phone page, scheduled tasks with no front-end run, and background terminal tasks do not. Windows only in this version
- 🎛️ **Reply Modes (per conversation)** — the mode pill at the left of the input bar ships four built-in tiers, each with its own icon and colour: **Smart** (every tool, touches neither prompt nor knobs — the default), **Chat** (no tools, single-turn direct answer), **Eco** (read-only tool whitelist + low reasoning effort + a tighter round cap), **Turbo** (all tools + high reasoning + a looser round cap). The choice applies to that one conversation (switch sessions and each keeps its own; a new conversation starts from the default), and the default plus any custom modes live under **Extensions → Modes**. **The model can mint modes itself**: `mode_write` creates / updates / deletes one with an appended prompt, a tool whitelist, a reasoning effort and a round cap, and in Manual approval the dialog shows you exactly what it is about to change. The whitelist genuinely blocks: a tool that is not opened is dropped from the native tools schema and the text catalogue alike, and a model calling it from memory is stopped at the execute gate with a note that the mode does not allow it; the Eco whitelist is "can look, cannot touch, cannot run commands, cannot spend generation budget"
- 👥 **AI Team Multi-Round Debate** — Multi-role propose/oppose/decide with light/heavy model division; plus DAG workflow pipeline with **8 built-in templates** (Dev Flow, Code Review, Doc Generation, Data Analysis, Research Report, Product Requirements, Bug Investigation, Parallel Research); stop button for mid-debate interruption, completed replies kept; the decision can wait for your sign-off, and a debate finishing while you are elsewhere comes back to the task centre where you can jump into it; **9 built-in team presets** (Code Review, Product Brainstorm, Red-Blue Debate, etc.) + custom configuration; workflow import/export/delete
- 🏢 **Office (Chat + Desks)** — one top-level Office page: it opens on Chat, and the Desks view holds the AI staff roster, virtual floor and assignment bar. Employees pick up work from their duty schedule, deliveries land in Activity and Waiting on You, and one click on a record opens that conversation. The sign-off flag stays visible on the Chat side, so you can approve without switching pages
- ⏰ **Scheduled Chat Tasks** — Auto-execute preset prompts on schedule, results archived as separate sessions
- ➕ **Unified ＋ Mode Menu** — one ＋ button left of the chat input consolidates every mode entry: Grind / Brainstorm / Target Mode / Scheduled Tasks, plus an **@-mention group** (Skills / Tools / MCP / Files) that opens a filtered picker; the panel is anchored above the ＋ button and closes on a second press, a click outside, or Esc — works in both the classic and the minimal Codex UI
- 🗂️ **Sortable sidebar task list with four status marks** — the Tasks tab and the Codex history rail share one sort preference (recent / by project / by status / created / by usage); every conversation carries its own mark: needs action, error, running (breathing animation), done-but-unread. Read state stays on this device, the sort preference syncs across devices
- 🧠 **Upgraded Whiteboard** — Card + connector brainstorming, Mermaid-rendered flowcharts & mindmaps, flow/kanban/outline/Git-tree/workflow modes, draggable Git tree view for branches/commits/worktrees/staged/unpushed state, and auto-logged tool execution steps. The Workflow view also drives the conversation from the board (stop / resume / autopilot / response mode / reasoning effort) and puts your flow playbooks, the live run and the team star map on one screen
- 💾 **Long-Term Memory & Knowledge Base** — Auto-distill chat highlights, cross-session recall; **overwrite outdated memories and delete obsolete ones** via AI-driven add/overwrite/delete actions; **✨ Spark** — auto-capture technical insights when conversations end, archive as knowledge docs for future RAG injection
- 🗜️ **Smart Context Compression** — Auto-summarize over threshold; the summary is still sent to the model in full but renders as a collapsed strip in the transcript and expands on click, so a long history does not push the conversation off the screen. Four-layer truncation defense with auto-continuation, four-layer timeout prevention
- 🎛️ **AI Assistance Control Panel** — Every token-spending feature outside the chat loop (compression, memory distill, insights, auto session title, code understanding, review, board organize, prompt polish, sub-agents, command explanation, workflows, scheduled tasks, image/video generation) gets its own switch and an optional pinned model under Settings → AI Assistance; off means not a single request, and the three tool-driven ones also vanish from the tool catalogue
- 🏭 **Prompt Factory** — Constitution + context + constraints integrated into a deliverable prompt (entry: "Settings → Context & Project", opening a modal workbench; it no longer takes a top-bar tab or a spot in the input toolbar)
- ✦ **Prompt Polish** — The button to the left of the mic hands your half-written draft to the current model for a rewrite; it appears beside the original in a review dialog and only **Use it** writes it back, so nothing changes unless you approve it. Decline with **Keep original** / `Esc` / clicking outside, and if you edit the draft while waiting that rewrite is dropped rather than pasted over your new words. The model's reasoning stream is discarded entirely, so no thinking noise leaks into the review
- 🎤 **Voice Input** — Click the mic button to dictate messages via Web Speech API; auto-detects language (Chinese/English); real-time transcription preview
- 🌍 **Multilingual UI** — Choose Simplified Chinese or English at install time; buttons, section labels, input placeholders and hover titles all go through the dictionary, while anything the user or the model wrote is never rewritten, and the brand mark 席 is exempted via `data-i18n-skip`

---

## 🧩 Feature Landscape

### Multi-Model Chat

- Preset models: GPT / Claude / Gemini, DeepSeek / Kimi / Qwen / GLM / Doubao / MiniMax / ERNIE, etc.
- Custom models (any OpenAI-compatible API) and local models supported
- Optional Responses API mode for compatible OpenAI-style models
- One-click sidebar switching, API Keys encrypted locally
- Streaming output, code block copy, smart scroll follow, regenerate last reply

### Agent Autopilot

- Project/action requests are detected automatically and run through an Agent loop without requiring you to type "continue"
- Default loop budget: 24 rounds for ordinary environment tasks, 40 rounds for broad project-wide tasks; Harness keeps its configurable 80-round strong mode
- Stop when it's done: once every deliverable is verified the model must call `exit_autopilot` / `exit_target_mode` to close the loop; any other exit is reported as interrupted and offers a one-click resume
- If a model only says it will inspect/edit/verify, SLATE Teams nudges it to call tools; if it claims completion without tool evidence, SLATE Teams asks it to verify or actually act
- **Continue Autopilot (toggle in Settings, on by default)**: running out of rounds is not the same as being done. When the last round was still executing tools, the budget is topped up by 8 rounds (at most 3 top-ups) so the work in flight can finish; when the model stops without doing anything, the open TODOLIST items are read back to it and it is told to either keep going or write 【任务完成】 explicitly
- **Auto-resume at the cap**: when every top-up is spent and the loop really dismisses, the system presses "继续跑完" for you — at most 2 auto-resumes per conversation, and the resumed run closes through the normal completion channel. The toast says which one it is. It keeps its hands off in two cases: this conversation is on the Manual approval tier (that tier means every step needs a human nod), or the Continue Autopilot switch is off — then the resume bar stays on screen for you to click
- Tool results are fed back invisibly so the model can observe → act → verify → report in one run
- **InkStream**: while the model writes a tool call token by token, a local schema-aware prefix parser infers which fields are already closed and which one is still being written, and renders that as a live one-line preview — preview only, half-formed arguments never enter execution, and large content fields fold into line / character counts
- **Real cancellation**: Stop closes the LLM stream and the tool-call stream together, and the backend terminates the subprocess or task through its `CallContext`; cancelled calls get their own status instead of being blurred into "done"
- **One loop, one ledger, one label source**: desktop and mobile run the same agent-loop kernel, and every plan / start / finish / cancel is written as an event into the local ledger (`runs` + `tool_events`). The chat tool card, the mobile card, and the whiteboard step card are projections of that ledger and take their titles from one label source (`services/tool_meta.js`), so no surface ever degrades to a raw tool name

### Target Mode (Harness)

- Six-phase loop: Goal → Plan → Execute → Verify → Report → Trace
- Auto-generates TODOLIST for large tasks (live right-rail display; collapse it anytime with the "Task list" button on the chat header, which keeps reporting `{done}/{total}` while folded), batch progress tracking, no sign-off until all items resolved
- 80 tool-call rounds by default; exits only on: manual stop / rounds exhausted / checklist done / model called `exit_target_mode` — model failures, zero output, and repeated calls auto-recover
- Each round shows current round number (x/N), model self-paces based on remaining budget
- Four-layer truncation defense: 6-round anchor continuation + truncation guard + `file_append` segmented write + prompt prevention

### Grind Mode

- Type `/grind <idea>`, or open the **＋ menu** (left of the chat input) → Grind Mode, to refine rough ideas into a structured task brief
- Three-phase questioning: Receive → Grind → Collect (up to 10 rounds), sidebar ink panel marks ✔ resolved / ✘ unknown in real-time
- Brief includes goals / audience / deliverables / acceptance criteria / boundaries / suggested path / open questions; three actions: send to Target Mode / push to whiteboard / save as template
- Grind sessions persist and auto-restore on refresh or switch

### MCP Tools & Skill System

Built-in tools — 35 in total (`backend/skills/`):

| Tool | Description |
|------|-------------|
| `file_tree` / `file_peek` | Browse project structure / Read files |
| `file_create` / `file_edit` | Create files / Diff-preview editing; preserves UTF-8/BOM/GB18030/GBK/UTF-16 and handles Chinese/emoji safely |
| `file_append` | Append to files, segmented writes for long content |
| `terminal` | Sandboxed command execution; hidden Windows subprocesses and Unicode-safe native output capture. On Windows each command runs in its own PowerShell process, so multi-line blocks and `&&` / `||` work, syntax errors come back with a failing exit code, and `cd` / `$env:` persist across commands |
| `bg_task` | Background terminal tasks: `action=start` returns immediately (pid, first output, log path) instead of holding the chat; ask later with `status` / `log`, or start with `notify=true` and get woken with the output tail when the task ends or matches your regex; `action=stop` kills the whole process tree. Tasks live as long as the backend process, logs land in `data/bg_tasks/`, high-risk commands still need approval |
| `html_render` / `css_color` | HTML skeleton generation / CSS color tuning |
| `doc_write` / `text_summarize` | Markdown writing / Text summarization |
| `ppt_create` / `word_create` | .pptx presentations / .docx Word documents |
| `excel_tool` / `pdf_tool` | Excel/CSV spreadsheets (generate .xlsx, read tables, csv↔xlsx conversion) / PDF metadata, text and table extraction |
| `json_tool` / `regex_test` | JSON processing / Regex testing |
| `code_search` | Project-wide code search by text or regex, defaults to the project root, scope narrowable to a subdirectory |
| `repo_stats` / `todo_scan` | Repository stats / TODO scanning |
| `system_info` | System metacognition: date/time, hardware specs, battery, network status |
| `git_tool` | Read-only git info: branch state, commit log, diff stats, branch and remote lists |
| `web_search` / `web_fetch` | Web search (no key needed) / Page content retrieval |
| `chart_create` / `qrcode_create` | SVG charts (bar/line/pie) / QR codes, inline preview |
| `python_api_extract` / `html_bundle` | Python library API extraction / Web page bundling |
| `code_scan` / `doc_scan` | Code security scanning (hardcoded keys / SQL injection / XSS / weak crypto / debug leftovers) / Document security scanning (PII, credentials, financial data, confidentiality marks across md/docx/pptx/xlsx/pdf) |
| `mcp_factory` | Tool factory — generated tools land in `data/evolved/`, disable / roll back / revoke under Extensions → New features |
| `browser_automation` / `computer_use` | Browser automation (Playwright) / Desktop automation (mouse/keyboard) |
| `screenshot_to_code` | Screenshot to code — AI reads image and generates HTML/CSS to match |
| `image_gen` / `video_gen` | AI image generation / AI video generation (OpenAI-compatible endpoints, model and API key configured in Settings), returns local file and preview link |

Custom Skills: Upload or import `SKILL.md` to extend capabilities; `@` mention in chat to auto-inject context.

Self-evolving tools (tool factory): `mcp_factory` lets SLATE Teams write the tools it is missing and use them itself. Products land in the user data area `data/evolved/` — one code file plus one manifest per tool — and **never in the `backend/skills/` source tree**: an upgrade can't wipe `data/`, and a running program shouldn't edit itself. Leftovers older versions wrote into the source tree are copied over at startup (copied, never deleted). Manage them under the top **Extensions** tab → **New features**, where every entry states its state: working / disabled / broken (with the syntax-error line) / shadowed by a built-in tool of the same name. Disabling removes the tool from the model's toolbox entirely instead of failing on call; overwrite, revoke and rollback each take a backup in `data/evolved/.history/` (up to 5 versions per tool), so anything "conflicting with an update" can be undone at any time. Code that doesn't compile never reaches the disk (the gate compiles, it never executes for you), creating a tool named after a built-in is refused on the spot, and on a name clash the built-in wins — with the shadowed copy still visible and revocable. `@` mentions, `skill_search` and the system prompt all carry the currently enabled self-produced tools.

Action Playbooks: Write the required flow for a recurring task into `data/actions/<id>.yml` (`name` / `description` / `when` / `inputs` / `steps` / `output`). In Agent mode the model sees the catalog, searches it with `actions_list`, reads a playbook with `actions_read`, then carries out the steps — reading a flow is never evidence the flow ran. Files parse through SAY-1, a zero-dependency YAML subset (2-space indent, block arrays, `|` literal blocks; tabs, anchors and multi-document files are rejected with the offending line number), and an unparsable file stays visible in Settings and in tool output instead of vanishing. The Settings panel edits them directly (validate-as-you-type, save refuses an invalid draft), every overwrite or delete copies the previous text into `data/actions/.history/` for rollback, `@<id>` in the chat box injects the flow up to a 6000-character cap, and the model can write one itself with `actions_write` — which demands an `author: model` declaration and, in "Ask" permission mode, your approval on the exact content.

### Expert Packs

- Five-piece structure: `persona.md` + `rules.md` + `knowledge/` + `skills/` + `data.json`
- Zip import/export, shareable; includes sample pack "Creative Writing Mentor"
- Three injection paths: chat dropdown (session-wide), team member cards (role-configured), @mention (single-message injection)

### Better Project Understanding

- Three scan budgets: brief / balanced / detailed, priority-reading of README, dependency manifests, and core files
- Auto-generates two documents: project guide & encyclopedia, and rulebook (evidence-based dev rules)
- Results persisted to `.slate/config.json`, instant access on reopen

### Code Review

- Read git diff in three modes: unstaged changes, staged changes, commit range
- AI reviews across four dimensions: code quality, security, performance, maintainability
- Structured report with overall assessment, per-dimension analysis, and line-level comments
- Line-level comments with severity badges (critical/major/minor/info), clickable file:line locations
- Three result views: full report (Markdown), line comments list, four-dimension cards

### Scheduled Tasks

- Three scheduling modes: one-time / daily at time / fixed interval
- **Event-driven triggers**: file change watcher / Git push detector / Webhook receiver — auto-execute tasks when events occur
- Backend asyncio scheduler calls model directly, results archived to `[Scheduled]` or `[Event]` prefixed sessions
- Frontend visual management: add/remove, enable/disable, run now, execution status display

### Chat & Data Management

- Full-text content search in history sidebar, context excerpts on match, click to jump to session
- Settings sidebar lists every section (entries generated from the sections themselves), with a search box on top that highlights the matching row
- Rename sessions, export as Markdown, batch manage/delete; messages support individual edit/delete
- **Session archive**: every row in the Tasks rail has Archive in its hover actions — archiving is not deleting, it only takes the conversation out of the task list. A run that is still generating is blocked with a reason (the task centre, the wake-up pool and the progress all point at that row, so hiding it would look like the job stopped by itself). Archived conversations live under Settings → Session archive, where each one can be restored (back into the Tasks rail) or deleted for good after a confirmation — deleting also clears its messages
- **Auto session title**: after a new conversation's first exchange the model is asked for a short title. Only placeholder titles (the "first 30 characters of the first message" kind) get replaced — names you typed yourself, and names given by background tasks and team runs, are left alone; the title is re-checked right before the write, because you may have renamed it during the request
- One-click backup: all data (chats/memories/assets/settings) exported as JSON, import to restore
- Storage management: itemized usage, database compression, clear chats, WebView cache cleanup
- LAN remote switch: QR code / authorised address display, and it can be turned off at any time — off really releases the listening port rather than hiding the address. The switch only works on the host running SLATE Teams, not from a phone
- First-launch onboarding guide
- Auto-check for updates on startup, prompts upgrade when new GitHub Release found

### SLATE Teams Mobile (Remote UI)

- Phone/tablet browsers visiting the LAN address automatically get the dedicated mobile UI (desktop UAs keep the full desktop interface — zero regression)
- Bottom-tab navigation with five panels: Chat / Conversations / Memory / Schedule / Settings
- Full chat capability: streaming output, tool loop on the same agent-loop kernel as the desktop, bottom-sheet risk approval and diff previews, @-mentions, voice input
- Session history management, long-term memory CRUD, scheduled tasks, and streamlined settings (model switching, API keys, theme, LAN info)

### AI Team Collaboration

- Multi-model / multi-role debate rounds: propose → support/oppose/rebut → decide
- Light models for discussion, heavy models for final decisions
- Auto-generated discussion summaries (≤500 tokens), user can intervene with votes
- **Stop mechanism**: Abort mid-debate with one click; completed replies are preserved
- **Whiteboard integration**: Debate steps auto-logged as cards with action type and summary
- **Persisted discussions**: Each turn is stored beyond local history — a team session with its roster and one event-ledger run per member — feeding the Whiteboard → Workflow star map; if the write fails, local history stays and that session is labelled "Local only"
- **No invented speeches**: When a member's request fails or has no API key, that row is marked "Failed" / "Did not join" — it never enters the next member's context (a model would otherwise argue with an error message) and never counts towards speech totals or the star map
- **Decision sign-off**: "Decision needs my sign-off" is on by default — once the decider speaks the debate waits for you; approve closes it, continue re-opens it marked "Not signed off" (re-opens are capped, so it can't burn tokens forever). Night mode (full access) never interrupts but still draws that row as auto-approved
- **Findable when it runs in the background**: The debate keeps going while you are on another panel; awaiting sign-off and the final result land in the same right-hand task list as background terminal jobs and sub-agent batches, and the row's button jumps back to that session. A manually stopped debate is kept in history, labelled "Interrupted", and still opens to show the replies completed so far
- **Team Workflow DAG**: Requirements → Decompose → Code → Review → Summarize pipeline with upstream/downstream artifact passing, real-time node status, auto-archive to knowledge base; **parallel execution** for independent nodes, **stop button** for mid-run interruption

### Whiteboard Logic Chain

- Idea/feature/thought cards, drag-to-layout, arrow connectors for dependencies and data flow
- Mermaid.js rendered flowcharts & mindmaps
- Display modes: main freeform board, Git tree, flow, kanban, outline, and workflow
- Git tree recognizes the opened project's repository state: HEAD, local/remote branches, commits, tags, remotes, worktrees, staged/changed/untracked counts, stashes, and unpushed commits; nodes and canvas are draggable in SLATE Teams style
- **Auto-logging**: Tool execution steps automatically create step cards with icons, descriptions, and status colors (yellow=running, green=done, red=error); the cards are a projection of the call event ledger — created and updated per call id, cleared when a new run starts, and titled from the same label source as the chat tool cards
- **Workflow view**: one screen is both the console and the scene — a run bar (stop / resume / autopilot / response mode / reasoning effort, sharing the same state the chat header writes), a flow wall (one card per `data/actions/*.yml` playbook, "Run this" sends it into the chat as an @mention), the current run projected from the event ledger (patching only its own subtree, so a per-second tick never re-renders the board), and a team star map whose reply edges, tool leaves and sub-agent spawns all come from real records
- **Thinking process display**: Model reasoning/thinking shown in collapsible panel, auto-collapses after thinking completes

### More

- 📦 **Multimodal Input**: docx / csv / markdown / html / images, backend parsing with zero token waste
- 💾 **Long-Term Memory**: Auto-distill chat highlights, cross-session persistence
- 📚 **Knowledge Base**: Local knowledge snippet retrieval and injection
- 🛡️ **Terminal Security**: Hardcoded high-risk command rules, frontend approval + backend interception dual defense, a per-conversation approval tier (manual asks each call / auto asks only high-risk / Night Mode runs unattended and won't even ask you a clarifying question), catastrophic commands (`rm -rf /`, `format`, etc.) unconditionally blocked
- 🔤 **Unicode-Safe Local Tools**: File editing and terminal output handle Chinese, emoji, UTF-8 BOM, GB18030/GBK, and UTF-16 without mojibake or accidental re-encoding
- 🔒 **Full Sandbox Protection**: Path traversal prevention (sensitive system dirs blacklisted), credential file access blocked, output truncation (50K chars), file size limits (5MB), request body size cap (20MB), upload filename sanitization, ReDoS timeout protection, env var cleanup — all transparent to users, zero friction
- 🗜️ **Context Compression**: Auto-summarize over token threshold, manual compression supported
- 🏭 **Prompt Factory**: Constitution summary → context snippets → task description → constraints → delivery requirements
- 🎨 **Themes & Custom Look**: Light / Dark one-click switch; under Settings → Custom theme four source colours (background / panel / body text / accent) derive the whole palette, with 10 presets, body and code font pickers, a panel-opacity slider, fonts imported from your own font files, and a local background image with an opacity slider. It can also pull the preview of whatever wallpaper Wallpaper Engine is currently using — read-only: it touches only the config and preview files Wallpaper Engine wrote for itself, never launches it and never changes its settings, and a new wallpaper on that side does not follow over until you click again. While a custom theme is on, the dark/light switch locks — clicking it explains why nothing changed and where to turn it off instead of failing silently. The file-type icons in the project bar follow the accent colour too (multi-colour icons are tinted by hue)

---

## 🚀 Quick Start

### Option 1: Windows Installer (Recommended)

1. Download `SLATE-Teams-Setup-x.x.x.exe` from [Releases](https://github.com/CaryWang1234/SLATE-Teams/releases)
2. During installation, choose your interface language (Simplified Chinese / English), then launch
3. Configure your model API Keys in Settings

### Option 2: Run from Source

**Prerequisites:** Python 3.13+

```bash
git clone https://github.com/CaryWang1234/SLATE-Teams.git
cd SLATE-Teams
pip install -r requirements.txt
```

**Windows:**

```bash
start.bat
```

**Linux / macOS:**

```bash
chmod +x start.sh
./start.sh
```

Then visit `http://127.0.0.1:8000`

`./start.sh` is already windowless and remote control works as usual. To start from the desktop entry point without a window, run `python desktop.py --remote` (packaged build: `SLATE-Teams --remote`): no window and no tray, and the authorised remote address is printed to the terminal.

### Build Desktop Package Yourself

```bash
build_desktop.bat      # PyInstaller single-file desktop app
build_installer.bat    # Inno Setup Windows installer (requires ISCC)
bash build_macos.sh    # macOS: PyInstaller + DMG (must run on a Mac; produces SLATE-Teams-Setup-<version>.dmg)
```

---

## 🛠️ Tech Stack

| Layer | Choice |
|-------|--------|
| Frontend | Vanilla HTML + CSS + JavaScript (ES Modules, zero build) |
| Backend | Python 3.13+ · FastAPI · Uvicorn · httpx |
| Storage | SQLite (chat history) · JSON (state / schedules / constitution) |
| Rendering | Highlight.js · Mermaid.js (CDN) |
| Desktop | webview2 shell + PyInstaller + Inno Setup installer |

---

## 📁 Directory Structure

```
SLATE-Teams/
├── desktop.py                  # Desktop entry (webview shell, PyInstaller target)
├── desktop_tray.py             # Windows tray (ctypes straight to Shell_NotifyIcon; closing hides to the notification area)
├── desktop_instance.py         # single-instance gate (named mutex; a second launch wakes the running window instead of starting a second backend)
├── desktop_platform.py         # platform differences (installed data dir / log location / webview renderer) — pure functions taking a platform string, so the macOS branch can be executed and asserted on Windows
├── start.bat / start.sh        # Source one-click launch (Windows / Unix)
├── build_desktop.bat           # PyInstaller build script
├── SLATE_Teams.spec                  # PyInstaller config
├── SLATE_Teams.iss         # Inno Setup installer script
├── build_macos.sh              # macOS packaging (PyInstaller → .app → DMG; must run on a Mac)
├── SLATE_Teams_macos.spec            # macOS PyInstaller config (.app bundle, Info.plist, cocoa backend manifest)
├── README.md / README-zh.md    # Project docs (English / Chinese)
├── GUIDE.md                    # Bilingual user guide (source)
├── QODER.md                    # Development specification
├── backend/
│   ├── main.py                 # FastAPI entry (static serving + route registration + scheduler)
│   ├── slate_yaml.py           # SAY-1 parser: the zero-dependency YAML subset for Actions (rejects tabs/anchors/multi-doc, errors carry line numbers)
│   ├── keepawake.py            # Night-mode keep-awake: the only place that touches the power API — SetThreadExecutionState is recorded per thread, so set / read-back / clear all live on one resident daemon thread and the lease is renewed by heartbeat
│   ├── routers/
│   │   ├── proxy.py            # LLM API proxy (multi-vendor streaming + segmented timeout)
│   │   ├── chat.py             # Chat history / context compression
│   │   ├── scheduler.py        # Scheduled task dispatcher
│   │   ├── knowledge.py        # Knowledge base retrieval
│   │   ├── projects.py         # Project management / Better Project Understanding / Code Review
│   │   ├── experts.py          # Expert pack CRUD / zip import/export
│   │   ├── skills.py           # Skill invocation (incl. /skills/stream — closing the stream cancels)
│   │   ├── actions.py          # Actions API (catalog / detail / dry-run validation / write / delete / .history rollback)
│   │   ├── events.py           # Agent call event ledger writes (runs / tool_events)
│   │   ├── settings.py         # Settings / cross-device sync / storage management
│   │   ├── constitution.py     # Project constitution
│   │   ├── grind.py            # Grind Mode session state machine
│   │   ├── i18n.py             # UI language config (install-time choice, read-only at runtime)
│   │   ├── update.py           # Startup update check (GitHub Releases)
│   │   ├── keep_awake.py       # Keep-awake routes (renew lease / read back status / explicit release); silently reports "unsupported" off Windows
│   │   ├── workflows.py        # Team workflow DAG definition
│   │   └── files.py            # Multimodal file parsing
│   └── skills/                 # 35 built-in MCP tool implementations (incl. Unicode-safe file/terminal tools, background terminal tasks, high-risk command dual interception, and a cancellable call context)
├── frontend/
│   ├── index.html              # Page entry (5 tabs: Office (Chat + Desks) / Team / Whiteboard / Extensions / Settings); Prompt Factory is now a modal opened from Settings
│   ├── m.html                  # Mobile remote UI entry (SLATE Teams Mobile)
│   ├── css/style.css           # Global styles (dual theme)
│   ├── css/mobile.css          # Mobile styles
│   └── js/
│       ├── app.js              # Main controller initialization
│       ├── store.js            # Global state management
│       ├── components/         # Chat / Whiteboard / Team / Skills / Memory / Schedule etc.
│       ├── services/           # api / adapter / tools / i18n / grind / agent_loop (loop kernel) / agent_ledger (event ledger) / tool_meta (label source) / inkstream / keepawake (should we hold the machine awake + heartbeat lease)
│       └── mobile/             # Mobile modules (init / app / ui / chat / conversations / memory / schedule / settings)
├── docs/                       # Website Landing Page (GitHub Pages)
│   ├── index.html              # English version
│   ├── zh/index.html           # Chinese version
│   └── guide.html              # Bilingual tutorial (scroll-style)
├── installer/                  # Installer artifacts
└── data/                       # Runtime data (SQLite / constitution / schedules / custom Skills / Action playbooks / expert packs / grind sessions)
```

---

## 🧭 Design Principles

- **Graphite paper + red-ink accent (Seat · Ledger)**: No blue-purple gradients, no excessive rounding, no shadow/frosted glass — and none of the original's warm-paper gold
- **Native tech**: Zero npm / Node.js, zero build tools, frontend is files — edit and it takes effect
- **Local-first**: All data stored locally, API Keys used only for LLM calls
- **Token economy**: Smart compression, tiered calls, silent processing
- **Never stuck**: Idle watchdog + zero-content auto-retry + request timeout + UI fallback — four layers of defense

---

## 🤝 Contributing

Issues and Pull Requests welcome:

1. Fork this repo and create a feature branch: `git checkout -b feat/your-feature`
2. Please maintain existing code style (vanilla JS, no new build dependencies)
3. Submit PR describing the motivation and how to test

---

## 📄 License

This project is open-sourced under the [MIT License](LICENSE).

---

<div align="center">

*SLATE Teams — Grind inspiration into polished deliverables.*

</div>
