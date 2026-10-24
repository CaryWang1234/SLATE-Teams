/**
 * 内联 SVG 图标集（Feather/Lucide 风格：24×24 viewBox，stroke=currentColor）。
 * 用于替代界面中的 emoji 图标，保证中英文模式下外观一致。
 * MCP 品牌 mark 走 mcp_icons.js（fill=currentColor，同样跟着文字颜色走），
 * 不能退成 <img src>：那种写法下 currentColor 只会变成黑色，暗色主题等于没画。
 *
 * 用法：
 *   iconSvg(name, cls)  → 返回 <svg> 字符串（可赋给 innerHTML）
 *   iconSvgEl(name, cls) → 返回 SVG 元素（可 appendChild）
 *   iconText(name, text) → 返回 <span class="icon-text">图标+文本</span>（文本走 textNode，无 XSS）
 */

import { CUSTOM_ICONS, CUSTOM_VIEWBOXES } from "./icons_custom.js?v=20261024-001";
import { MCP_ICONS, MCP_VIEWBOXES } from "./mcp_icons.js?v=20261024-001";
import { MODEL_ICONS, MODEL_VIEWBOXES } from "./model_icons.js?v=20261024-001";

const ICONS = {
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  lightbulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
  "pen-tool": '<path d="M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  "book-open": '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/>',
  menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/>',
  crosshair: '<circle cx="12" cy="12" r="9"/><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM3 12h3M18 12h3M12 3v3M12 18v3"/>',
  "bar-chart": '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  "mouse-pointer": '<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3zM13 13l6 6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  "edit-2": '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  "rotate-ccw": '<path d="M1 4v6h6M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  "rotate-cw": '<path d="M23 4v6h-6M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  "trash-2": '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
  "alert-triangle": '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  "refresh-ccw": '<path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  map: '<path d="M1 6v16l7-3 8 3 7-3V3l-7 3-8-3-7 3zm7-3v16m8-13v16"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  "edit-3": '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  package: '<path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  "message-circle": '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  factory: '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1M12 18h1M7 18h1"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  "folder-open": '<path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83zM7 7h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  scroll: '<path d="M6 2h9a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 7h5M10 11h5M10 15h3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/><path d="M2 14h2M20 14h2"/>',
  "skip-forward": '<path d="M5 4l10 8-10 8V4zM19 5v14"/>',
  hourglass: '<path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  "corner-up-left": '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v4"/>',
  "corner-down-right": '<path d="M15 10l5 5-5 5M20 15H9a6 6 0 0 1-6-6V5"/>',
  "arrow-down": '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/>',
  terminal: '<path d="M4 17l6-5-6-5M12 19h8"/>',
  code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  git: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  node: '<path d="M12 2l8.7 5v10L12 22l-8.7-5V7z"/><path d="M9.4 16.2V8.6l5.2 7.3V8.6"/>',
  python: '<path d="M11.4 3.4c-2.6 0-4.4.9-4.4 2.9v2.5h4.5M12.6 20.6c2.6 0 4.4-.9 4.4-2.9v-2.5h-4.5"/><rect x="7" y="8.6" width="10" height="6.8" rx="3.4"/><path d="M9.4 5.8h.01M14.6 18.2h.01"/>',
  docker: '<path d="M3.4 12.8h15.2c2.1-2.6 1.3-5.1-.9-6.4.2 1.6-.7 2.6-1.8 2.9"/><rect x="5.4" y="10" width="2.7" height="2.7" rx=".5" stroke-width="1.3"/><rect x="8.7" y="10" width="2.7" height="2.7" rx=".5" stroke-width="1.3"/><rect x="12" y="10" width="2.7" height="2.7" rx=".5" stroke-width="1.3"/><rect x="8.7" y="6.9" width="2.7" height="2.7" rx=".5" stroke-width="1.3"/>',
  curl: '<path d="M14.3 7.2A5.8 5.8 0 1 0 14.3 16.8"/><path d="M13 12h8.6M18.4 9.4l3.2 2.6-3.2 2.6"/>',
  kubectl: '<path d="M12 3l6.6 2.4 2.6 6.4-3.8 5.8H8.6l-3.8-5.8 2.6-6.4z"/><circle cx="12" cy="12" r="2.2"/><path d="M12 9.8V6.9M13.9 13.2l2.3 1.8M10.1 13.2l-2.3 1.8"/>',
  braces: '<path d="M8.5 3.5H7.2a2.2 2.2 0 0 0-2.2 2.2v3a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0 2.5 2.5v3a2.2 2.2 0 0 0 2.2 2.2h1.3M15.5 3.5h1.3a2.2 2.2 0 0 1 2.2 2.2v3a2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 1-2.5 2.5v3a2.2 2.2 0 0 1-2.2 2.2h-1.3"/>',
  hash: '<path d="M4.5 9h15M4.5 15h15M10 3.5L8 20.5M16 3.5l-2 17"/>',
  image: '<rect x="3" y="3.5" width="18" height="17" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="M21 15.5l-4.5-4.5L6 20.5"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10.6L21.5 7v10l-6-3.6z"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h2.6v2.6H14zM20.5 14h.01M14 20.5h2.6M20.5 17.5v3"/>',
  palette: '<path d="M12 21.3a9.3 9.3 0 1 1 0-18.6c5.1 0 9.3 3.5 9.3 7.8 0 2.6-2.1 4.4-4.6 4.4H15a2 2 0 0 0-1.4 3.3 1.9 1.9 0 0 1-1.6 3.1z"/><circle cx="7.8" cy="11.3" r="1.1"/><circle cx="10.2" cy="7.3" r="1.1"/><circle cx="14.9" cy="8.1" r="1.1"/>',
  table: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 10h18M9.5 10v9.5M15.5 10v9.5"/>',
  presentation: '<rect x="3" y="3.5" width="18" height="12.5" rx="2"/><path d="M12 16v4.5M8.5 20.5h7M7.5 12l3-3.5 2.2 2 3.8-4"/>',
  plug: '<path d="M9 2.5v5M15 2.5v5M6 7.5h12v3.2a6 6 0 0 1-12 0zM12 16.7v4.8"/>',
  "file-plus": '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h4.5M12 12v5.5M9.2 14.8h5.5"/>',
  cloud: '<path d="M17.5 18.5H7a4.5 4.5 0 1 1 .8-9A6 6 0 0 1 19.7 11a4 4 0 0 1-2.2 7.5z"/>',
  activity: '<path d="M21.5 12h-4l-3 8-4-16-3 8h-4"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>',
};

const ICON_ALIASES = {
  "🔑": "key",
  "📡": "wifi",
  "⚙": "settings",
  "⚙️": "settings",
  "💡": "lightbulb",
  "🖌": "pen-tool",
  "⚡": "zap",
  "⏰": "clock",
  "🧠": "database",
  "🎓": "book-open",
  "✂": "scissors",
  "☰": "menu",
  "✦": "sliders",
  "🔍": "search",
  "🔎": "search",
  "🎤": "mic",
  "⌖": "crosshair",
  "📊": "bar-chart",
  "⇩": "download",
  "⬇": "download",
  "✋": "mouse-pointer",
  "🔗": "link",
  "✏️": "edit-2",
  "✎": "edit-2",
  "↩": "rotate-ccw",
  "↻": "rotate-cw",
  "⧉": "copy",
  "🗑": "trash-2",
  "⚠": "alert-triangle",
  "⚠️": "alert-triangle",
  "🔔": "bell",
  "💻": "monitor",
  "🔄": "refresh-ccw",
  "🌐": "globe",
  "🚫": "ban",
  "🛡": "shield",
  "🛡️": "shield",
  "🔓": "unlock",
  "📤": "upload",
  "⭐": "star",
  "🗺": "map",
  "📏": "book",
  "📝": "edit-3",
  "✍️": "edit-3",
  "📦": "package",
  "🔀": "shuffle",
  "💬": "message-circle",
  "🎯": "target",
  "🛠": "tool",
  "🏭": "factory",
  "💾": "save",
  "✓": "check",
  "✔": "check",
  "✅": "check",
  "✕": "x",
  "✗": "x",
  "❌": "x",
  "➕": "plus",
  "📄": "file",
  "📁": "folder",
  "📂": "folder-open",
  "🗒": "file-text",
  "🗂": "folder",
  "📋": "clipboard",
  "👀": "eye",
  "🏷": "tag",
  "ℹ️": "info",
  "📜": "scroll",
  "🧑": "user",
  "🤖": "bot",
  "⏭": "skip-forward",
  "⏳": "hourglass",
  "⏸": "pause",
  "⚔️": "compass",
  "🏗️": "tool",
  "🚀": "send",
  "↰": "corner-up-left",
  "↳": "corner-down-right",
  "⇣": "arrow-down",
  "✨": "sparkles",
  "☆": "star",
  "📚": "book",
  "🔧": "tool",
  "💭": "message-circle",
  "⏱": "clock",
};

export function iconSvg(name, cls = "") {
  const inner = ICONS[name] || CUSTOM_ICONS[name] || MCP_ICONS[name] || MODEL_ICONS[name] || ICONS[ICON_ALIASES[name]] || "";
  if (!inner) return "";
  const vb = CUSTOM_VIEWBOXES[name] || MCP_VIEWBOXES[name] || MODEL_VIEWBOXES[name] || "0 0 24 24";
  // 品牌 mark 与自绘图都靠 currentColor 描色，所以不能带 stroke 的默认属性
  const fill = (CUSTOM_VIEWBOXES[name] || MCP_VIEWBOXES[name] || MODEL_VIEWBOXES[name]) ? "fill=\"currentColor\"" : "fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"";
  return `<svg class="svg-icon${cls ? " " + cls : ""}" viewBox="${vb}" ${fill} aria-hidden="true">${inner}</svg>`;
}

export function iconSvgEl(name, cls = "") {
  const tpl = document.createElement("template");
  tpl.innerHTML = iconSvg(name, cls);
  return tpl.content.firstElementChild || document.createTextNode("");
}

/** 图标 + 文本（文本用 textNode，安全；图标名可用 emoji 别名或 icons 键名） */
export function iconText(name, text, cls = "") {
  const span = document.createElement("span");
  span.className = "icon-text" + (cls ? " " + cls : "");
  span.appendChild(iconSvgEl(name));
  span.appendChild(document.createTextNode(text ?? ""));
  return span;
}

/** 便捷：把已有元素清空后填充 图标+文本 */
export function setIconText(el, name, text, cls = "") {
  if (!el) return;
  el.textContent = "";
  el.appendChild(iconText(name, text, cls));
}

/** 把字符串开头的已知 emoji 前缀替换为 SVG（返回 HTML 字符串，仅用于受控文案） */
export function emojiToSvg(str, cls = "") {
  if (!str) return str;
  return String(str).replace(
    /([\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2300}-\u{23FF}])(?=\s|$)/gu,
    (m) => iconSvg(ICON_ALIASES[m] || m, cls) || m
  );
}
