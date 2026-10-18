
export function makeId(prefix = "") {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    const stamp = Date.now();
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (stamp >> ((i % 4) * 8)) & 0xff;
    }
  }
  return `${prefix}${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`;
}
