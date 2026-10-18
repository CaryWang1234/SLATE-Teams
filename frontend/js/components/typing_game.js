/**
 * 设置页打字小游戏：一段 ASCII 文本，逐字符比对，算 WPM 与准确率。
 *
 * 语料只放英文与符号：中文要走输入法，组合期的 input 事件是半截文本，
 * 计时和准确率都会被输入法节奏带偏，不如不做。
 * 准确率按「首次敲对的字符 / 总按键数」算，退格重敲会摊薄它，才像手速；
 * 一次事件塞进多个字符视为粘贴，成绩照算但不进最佳纪录。
 *
 * 自定义题库落在 data/typing_custom.txt（一行一条），经 /api/typing/corpus 读写。
 * 哪些行算题目在这里判（后端只管存文本），所以外部编辑器改完点「重新读取」即生效。
 */

import { get, post } from "../services/api.js?v=20261017-001";
import { t } from "../services/i18n.js?v=20261017-001";

// git / shell
const BUILTIN = [
  "git commit -m 'feat: ship the thing'",
  "git rebase -i HEAD~3 && git push --force-with-lease",
  "git stash push -u -m 'wip before refactor'",
  "git log --oneline --graph --decorate --since=2.weeks",
  "git diff --staged | tee /tmp/review.patch",
  "git switch -c feat/typing-corpus && git fetch --prune",
  "chmod +x scripts/deploy.sh && ./scripts/deploy.sh --dry-run",
  "find . -name '*.py' -not -path './dist/*' | xargs wc -l",
  "tail -f backend.log | grep --line-buffered 'WARNING'",
  "ls -laR /var/log 2>/dev/null | grep -i error | head -40",
  "tar -czf backup-$(date +%F).tar.gz data/ && ls -lh backup-*.tar.gz",
  "ssh -i ~/.ssh/id_ed25519 deploy@10.0.0.12 'systemctl status slate'",
  "export PATH=\"$HOME/.local/bin:$PATH\" && source ~/.bashrc",
  // PowerShell（Windows 端常见手活）
  "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5",
  "Select-String -Path *.log -Pattern 'Traceback' -Context 2,4",
  "$env:SLATE_DATA_DIR = 'C:\\Users\\caryw\\Desktop\\codes\\SLATE\\data'",
  "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force",
  // python
  "python -m uvicorn backend.main:app --reload --port 8000",
  "python -m pytest tests -k 'not slow' --maxfail=3 -q",
  "with open(path, encoding='utf-8') as f: data = f.read()",
  "print(json.dumps(obj, ensure_ascii=False, indent=2))",
  "assert abs(result - expected) < 1e-6, f'got {result}'",
  "sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))",
  "if __name__ == '__main__': asyncio.run(main())",
  "re.sub(r'[^a-z0-9]+', '-', title.strip()).strip('-')",
  "args = parser.parse_args(); logging.basicConfig(level=args.loglevel)",
  // javascript / typescript
  "const sum = arr.reduce((a, b) => a + b, 0);",
  "arr.filter(x => x > 0).map(x => x * 2).reduce((a, b) => a + b, 0);",
  "for (const [key, value] of Object.entries(map)) console.log(key, value);",
  "if (!response.ok) throw new Error(response.statusText);",
  "await Promise.allSettled(tasks.map(task => run(task)));",
  "Object.freeze({ ...defaults, ...overrides, version: 2 });",
  "export type Role = 'admin' | 'editor' | 'viewer';",
  "document.querySelectorAll('.tab').forEach(el => el.addEventListener('click', pick));",
  "try { await flushQueue(); } catch (err) { console.error('flush failed', err); }",
  "const { data, error } = await useAsyncData('user', fetchUser);",
  // sql
  "SELECT id, name FROM users WHERE active = 1 ORDER BY id DESC;",
  "UPDATE users SET last_seen = datetime('now') WHERE id IN (1, 2, 3);",
  "CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);",
  "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status HAVING n > 1;",
  "DELETE FROM sessions WHERE expires_at < datetime('now') LIMIT 500;",
  // 容器 / 网络 / CI
  "docker compose up -d --build && docker compose logs -f app",
  "docker run --rm -it -v $PWD:/app -w /app node:22 sh",
  "docker system df -v | grep -E 'images size|build cache size'",
  "kubectl rollout status deployment/slate --timeout=120s",
  "curl -sS -X POST http://127.0.0.1:8000/api/health -d '{}'",
  "curl -I -sS https://api.github.com/zen | head -5",
  "wget -q -O - http://127.0.0.1:8000/api/settings/state | jq '.code'",
  "gh pr create --base main --fill && gh pr checks --watch",
  "npm install --save-dev && npm run build -- --minify",
  "npx tsc --noEmit --pretty && npx vitest run --reporter=dot",
  // 前端与标记语言
  "grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));",
  "box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.12);",
  "@media (prefers-reduced-motion: reduce) { * { animation: none; } }",
  "<meta name='viewport' content='width=device-width, initial-scale=1'>",
  "{\"ok\": true, \"data\": {\"count\": 3, \"items\": [\"a\", \"b\", \"c\"]}}",
  // 英文散文：练大小写、标点与移位
  "The quick brown fox jumps over the lazy dog 0123456789",
  "Slate keeps the drafts, the diffs and the decisions in one place.",
  "To type fast is to think a little ahead of your fingers, not far.",
  "Practice in short bursts: five rounds, rest, then five new lines.",
  "QWERTY puts the busiest letter pairs under the weakest fingers.",
  "Never interrupt a coder in flow; do interrupt a runaway process.",
];

const BEST_KEY = "slate_typing_best";
const SOURCE_KEY = "slate_typing_source";
const MIN_LEN = 6;
const MAX_LEN = 220;

let targetEl, inputEl, timeEl, wpmEl, accEl, bestEl, resultEl, nextBtn;
let sourceEl, poolEl, customEl, pathEl, reloadBtn, saveBtn;
let customLines = [];
let customPath = "";
let skippedLines = 0;
let source = "mixed";
let target = "";
let prevLen = 0;
let keys = 0;
let correctKeys = 0;
let startedAt = 0;
let finished = false;
let pasted = false;
let timer = 0;

function notify(msg) {
  import("../app.js?v=20261017-001").then(({ toast }) => toast(msg)).catch(() => {});
}

function span(cls, text) {
  const node = document.createElement("span");
  if (cls) node.className = cls;
  node.textContent = text;
  return node;
}

/** 一行一条；空行与 # 开头忽略，非 ASCII 或长度不合的丢掉（中文要过输入法，计时会被带偏） */
function parseCustom(text) {
  const lines = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.length < MIN_LEN || line.length > MAX_LEN || !/^[\x20-\x7e]+$/.test(line)) {
      dropped += 1;
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return { lines, dropped };
}

function pool() {
  if (source === "builtin") return BUILTIN;
  const list = source === "custom" ? customLines : BUILTIN.concat(customLines);
  return list.length ? list : BUILTIN;
}

function refreshPoolLabel() {
  if (!poolEl) return;
  const bits = [];
  if (source !== "custom") bits.push(t("内置 {n} 条", { n: BUILTIN.length }));
  if (source !== "builtin") bits.push(t("自定义 {n} 条", { n: customLines.length }));
  if (skippedLines) bits.push(t("已跳过 {n} 行（非 ASCII 或长度不合）", { n: skippedLines }));
  if (source !== "builtin" && !customLines.length) bits.push(t("自定义题库为空，暂按内置出题"));
  poolEl.textContent = bits.join(" · ");
  if (pathEl) pathEl.textContent = customPath || "data/typing_custom.txt";
}

function applyCustom(content, { overwriteDraft = false } = {}) {
  const parsed = parseCustom(content);
  customLines = parsed.lines;
  skippedLines = parsed.dropped;
  if (customEl && (overwriteDraft || !customEl.value.trim())) customEl.value = content || "";
  refreshPoolLabel();
}

async function loadCustom({ overwriteDraft = false } = {}) {
  const res = await get("/typing/corpus");
  const data = (res && res.data) || {};
  customPath = data.path || customPath;
  applyCustom(data.content || "", { overwriteDraft });
  if (!inputEl.value && !finished) nextRound();
}

async function saveCustom() {
  const text = customEl ? customEl.value : "";
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await post("/typing/corpus", { content: text });
    if (!res || res.code !== 0) throw new Error((res && res.message) || t("保存失败"));
    const data = res.data || {};
    customPath = data.path || customPath;
    applyCustom(data.content !== undefined ? data.content : text);
    if (!inputEl.value && !finished) nextRound();
    notify(t("已保存自定义题库，生效 {n} 条", { n: customLines.length }));
  } catch (e) {
    notify(String((e && e.message) || e));
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function paint(typed) {
  const nodes = targetEl.children;
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].className = "tc" + (i < typed.length
      ? (typed[i] === target[i] ? " ok" : " bad")
      : (i === typed.length ? " cur" : ""));
  }
}

function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}

function writeBest(wpm) {
  try { localStorage.setItem(BEST_KEY, String(Math.round(wpm))); } catch {}
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = 0; }
}

function elapsedSec() {
  return startedAt ? (performance.now() - startedAt) / 1000 : 0;
}

function currentWpm() {
  const sec = elapsedSec();
  return sec ? (correctKeys / 5) / (sec / 60) : 0;
}

function accuracy() {
  return keys ? Math.round((correctKeys / keys) * 100) : 100;
}

function refreshStats() {
  const sec = elapsedSec();
  timeEl.textContent = `${sec.toFixed(1)}s`;
  wpmEl.textContent = sec >= 1 ? String(Math.round(currentWpm())) : "0";
  accEl.textContent = `${accuracy()}%`;
}

function finish() {
  finished = true;
  stopTimer();
  refreshStats();
  const wpm = Math.round(currentWpm());
  const best = readBest();
  const record = !pasted && wpm > best;
  if (record) writeBest(wpm);
  bestEl.textContent = String(readBest());
  resultEl.textContent = record
    ? t("本局 {wpm} WPM · 准确率 {acc}% · 新纪录", { wpm, acc: accuracy() })
    : (pasted
      ? t("本局 准确率 {acc}%（粘贴不计纪录）", { acc: accuracy() })
      : t("本局 {wpm} WPM · 准确率 {acc}% · 最佳 {best} WPM", { wpm, acc: accuracy(), best: Math.max(best, wpm) }));
  resultEl.classList.add("show");
  inputEl.readOnly = true;
}

function nextRound() {
  stopTimer();
  const list = pool();
  let pick = target;
  while (list.length > 1 && pick === target) pick = list[Math.floor(Math.random() * list.length)];
  target = pick;
  prevLen = 0;
  keys = 0;
  correctKeys = 0;
  startedAt = 0;
  finished = false;
  pasted = false;
  inputEl.readOnly = false;
  inputEl.value = "";
  bestEl.textContent = String(readBest());
  resultEl.textContent = "";
  resultEl.classList.remove("show");
  targetEl.textContent = "";
  for (const ch of target) targetEl.append(span("tc", ch));
  refreshStats();
  paint("");
}

function onInput() {
  if (finished) return;
  const typed = inputEl.value;
  if (typed.length > prevLen) {
    if (typed.length - prevLen > 1) pasted = true;
    for (let i = prevLen; i < typed.length; i++) {
      keys += 1;
      if (typed[i] === target[i]) correctKeys += 1;
    }
    if (!startedAt) {
      startedAt = performance.now();
      timer = setInterval(refreshStats, 200);
    }
  }
  prevLen = typed.length;
  paint(typed);
  refreshStats();
  if (typed === target) finish();
}

export function initTypingGame() {
  targetEl = document.getElementById("typing-target");
  inputEl = document.getElementById("typing-input");
  timeEl = document.getElementById("typing-time");
  wpmEl = document.getElementById("typing-wpm");
  accEl = document.getElementById("typing-acc");
  bestEl = document.getElementById("typing-best");
  resultEl = document.getElementById("typing-result");
  nextBtn = document.getElementById("btn-typing-next");
  sourceEl = document.getElementById("typing-source");
  poolEl = document.getElementById("typing-pool");
  customEl = document.getElementById("typing-custom-text");
  pathEl = document.getElementById("typing-corpus-path");
  reloadBtn = document.getElementById("btn-typing-reload");
  saveBtn = document.getElementById("btn-typing-save");
  if (!targetEl || !inputEl || !resultEl) return;

  let saved = "mixed";
  try { saved = localStorage.getItem(SOURCE_KEY) || "mixed"; } catch {}
  source = ["mixed", "builtin", "custom"].includes(saved) ? saved : "mixed";
  if (sourceEl) sourceEl.value = source;
  refreshPoolLabel();
  nextRound();

  inputEl.addEventListener("input", onInput);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); nextRound(); inputEl.focus(); }
  });
  if (nextBtn) nextBtn.addEventListener("click", () => { nextRound(); inputEl.focus(); });
  if (sourceEl) {
    sourceEl.addEventListener("change", () => {
      source = ["mixed", "builtin", "custom"].includes(sourceEl.value) ? sourceEl.value : "mixed";
      try { localStorage.setItem(SOURCE_KEY, source); } catch {}
      refreshPoolLabel();
      nextRound();
      inputEl.focus();
    });
  }
  if (reloadBtn) {
    reloadBtn.addEventListener("click", async () => {
      try {
        await loadCustom({ overwriteDraft: true });
        notify(t("已重新读取题库文件"));
      } catch (e) {
        notify(String((e && e.message) || e));
      }
    });
  }
  if (saveBtn) saveBtn.addEventListener("click", saveCustom);

  loadCustom().catch(() => { /* 后端未就绪时先玩内置题库 */ });
}

// 供 scripts/check_typing_corpus.mjs 断言题库不变量与筛选规则
export { BUILTIN, parseCustom };
