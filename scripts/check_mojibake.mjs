#!/usr/bin/env node
/**
 * Repository-wide mojibake guard for SLATE.
 *
 * The check is deliberately heuristic: it catches common encoding damage
 * without requiring every file to be ASCII-only. It fails on replacement
 * characters, suspicious C0 control bytes, and repeated Chinese mojibake
 * marker characters produced by UTF-8/GBK mixups.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];

const skipDirs = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tmp-chrome-codex",
  ".venv",
  "__pycache__",
  "build",
  "data",
  "dist",
  "installer",
  "node_modules",
  "outputs",
]);

const textExts = new Set([
  ".bat",
  ".cmd",
  ".css",
  ".csv",
  ".html",
  ".ini",
  ".iss",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".rst",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const exactTextFiles = new Set([
  ".gitattributes",
  ".gitignore",
  "LICENSE",
]);

const maxBytes = 2 * 1024 * 1024;

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function shouldScan(file) {
  const name = path.basename(file);
  const relative = rel(file);
  return exactTextFiles.has(name) || exactTextFiles.has(relative) || textExts.has(path.extname(name).toLowerCase());
}

function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      listFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile()) {
      const file = path.join(dir, entry.name);
      if (shouldScan(file)) out.push(file);
    }
  }
  return out;
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function snippet(line) {
  return line.trim().slice(0, 180);
}

function addError(file, line, message, sample = "") {
  const loc = `${rel(file)}:${line || 1}`;
  errors.push({ loc, message, sample });
}

function scanFile(file) {
  const stats = statSync(file);
  if (stats.size > maxBytes) return;

  const buf = readFileSync(file);
  if (buf.includes(0)) return;

  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);

  const replacementAt = text.indexOf("\ufffd");
  if (replacementAt !== -1) {
    const line = lineNumber(text, replacementAt);
    addError(file, line, "contains UTF-8 replacement character; the file was likely decoded with the wrong encoding", snippet(lines[line - 1] || ""));
  }

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    const control = line.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    if (control) {
      addError(file, lineNo, "contains unexpected control characters", snippet(line));
    }

    const mojibakeMarkers = line.match(/[\u923a\u923d\u9365\u9359\u9366\u936b\u9375\u93c8\u95ab\u95b0\u95c6\u95c7\u95c8\u941a\u9422\u951b\u951f\u7efb\u7ead\u7f01\u9983]/g);
    if (mojibakeMarkers && mojibakeMarkers.length >= 3) {
      addError(file, lineNo, "contains repeated CJK mojibake marker characters", snippet(line));
    }

    if (/[\u00c0-\u00ff]{3,}/.test(line) && /[^\x00-\x7f]/.test(line)) {
      addError(file, lineNo, "contains suspicious Latin-1 mojibake sequence", snippet(line));
    }

    if (/(?:\u00e2[\u0080-\u00bf]{1,2}|\u00ef\u00bc|\u00f0[\u0080-\u00bf]{2,3})/.test(line)) {
      addError(file, lineNo, "contains escaped-looking UTF-8 mojibake bytes", snippet(line));
    }
  });
}

for (const file of listFiles(root)) {
  scanFile(file);
}

if (errors.length) {
  console.error(`Mojibake check failed with ${errors.length} issue(s):`);
  for (const item of errors) {
    console.error(`::error file=${item.loc.split(":")[0]},line=${item.loc.split(":").at(-1)}::${item.message}`);
    console.error(`- ${item.loc} ${item.message}${item.sample ? `\n  ${item.sample}` : ""}`);
  }
  process.exit(1);
}

console.log("Mojibake check passed.");
