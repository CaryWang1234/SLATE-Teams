/**
 * SLATE Markdown 渲染器：将 Markdown 文本安全渲染为 HTML。
 *
 * 设计要点：
 * - 代码块/行内代码先整体转义，不参与后续内联格式化，避免代码被加粗/斜体规则污染
 * - 所有文本输出前做 HTML 转义，防止内容中的 < > & 破坏渲染
 * - 逐行解析块级结构，未闭合的 ``` 围栏按代码块处理（流式部分输出时不会裸露标记）
 * - 支持：围栏代码块、行内代码、加粗、斜体、删除线、链接、
 *   标题 h1-h6、引用、无序/有序列表、表格、分隔线、段落
 */

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 内联格式：行内代码、加粗、斜体、删除线、链接 */
function renderInline(raw) {
  if (!raw) return "";
  // 先拆出行内代码段，代码段内容只转义不格式化
  return raw
    .split(/(`[^`\n]+`)/g)
    .map(part => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      let s = escapeHtml(part);
      s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
      s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
      s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
      s = s.replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>'
      );
      // wiki-link: [[target]] or [[target|display]]
      s = s.replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_, target, display) => `<a class="vault-wikilink" data-target="${target.trim()}" title="${target.trim()}">${display || target}</a>`
      );
      return s;
    })
    .join("");
}

/** 围栏代码块（content 不含围栏行本身） */
function renderCodeBlock(lang, codeLines) {
  const cls = /^[A-Za-z0-9_+-]+$/.test(lang) ? lang : "text";
  return `<pre><code class="language-${cls}">${escapeHtml(codeLines.join("\n"))}</code></pre>`;
}

/** 表格行拆分：| a | b | → ["a", "b"] */
function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map(c => c.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

/** 将连续的普通文本行合并为段落（行内换行保留为 <br>） */
function flushParagraph(buf, out) {
  if (buf.length === 0) return;
  const html = buf.map(renderInline).join("<br>");
  out.push(`<p>${html}</p>`);
  buf.length = 0;
}

/**
 * 渲染 Markdown 为 HTML。
 * @param {string} text Markdown 源文本（可以是流式输出的部分文本）
 * @returns {string} HTML 字符串
 */
function renderMarkdown(text) {
  if (!text) return "";

  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const paraBuf = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── 围栏代码块（未闭合时吞并到文末，流式输出下仍按代码块渲染） ──
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushParagraph(paraBuf, out);
      const lang = fence[1].trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合围栏；未闭合时自然越界结束
      out.push(renderCodeBlock(lang, codeLines));
      continue;
    }

    // ── 空行：段落分隔 ──
    if (!line.trim()) {
      flushParagraph(paraBuf, out);
      i += 1;
      continue;
    }

    // ── 标题 ──
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph(paraBuf, out);
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // ── 分隔线 ──
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(paraBuf, out);
      out.push("<hr>");
      i += 1;
      continue;
    }

    // ── 引用（连续 > 行合并为一个 blockquote） ──
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paraBuf, out);
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${quoteLines.map(renderInline).join("<br>")}</blockquote>`);
      continue;
    }

    // ── 无序列表 ──
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph(paraBuf, out);
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // ── 有序列表 ──
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph(paraBuf, out);
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // ── 表格（表头行 + 分隔行） ──
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph(paraBuf, out);
      const headerCells = splitTableRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        bodyRows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headerCells.map(c => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
      const tbody = bodyRows
        .map(cells => `<tr>${cells.map(c => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table>${thead}${tbody ? `<tbody>${tbody}</tbody>` : ""}</table>`);
      continue;
    }

    // ── 普通文本行：累积到段落 ──
    paraBuf.push(line);
    i += 1;
  }

  flushParagraph(paraBuf, out);
  return out.join("");
}

export { renderMarkdown, renderInline, escapeHtml };
