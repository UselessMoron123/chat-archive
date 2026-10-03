// Benchmark: how much of a per-chat export time is local (parse + format + stringify)
// vs network. Uses the real 26 MB exported record from the archive.
import fs from "node:fs";
import { JSDOM } from "jsdom";

const SCRIPT = "/home/user/chat-archive/Arena.ai - LMSYS Arena Chat Exporter-2.3.2.user.js";
const source = fs.readFileSync(SCRIPT, "utf8");
const recordText = fs.readFileSync("/tmp/bench/big.json", "utf8");
const record = JSON.parse(recordText);
const id = record.agent.id;

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
  url: "https://arena.ai/search", runScripts: "outside-only", pretendToBeVisual: true,
});
const { window } = dom;
const document = window.document;
await new Promise((r) => (document.readyState !== "loading" ? r() : window.addEventListener("DOMContentLoaded", r, { once: true })));

let blobBytes = 0;
// The script fetches the raw API record; return the agent object as-is (no
// extra cloning in the mock, so the measured time is the exporter's own work).
const raw = record.agent;
window.fetch = async (url) => {
  const path = new URL(String(url), "https://arena.ai").pathname;
  if (path.startsWith("/api/evaluation/")) {
    return { ok: true, status: 200, statusText: "OK", text: async () => "", json: async () => raw };
  }
  return { ok: false, status: 404, statusText: "NF", text: async () => "", json: async () => ({}) };
};
window.fflate = { strToU8: (s) => new TextEncoder().encode(s), zipSync: (e) => new Uint8Array([1]) };
window.URL.createObjectURL = () => "blob:x";
window.URL.revokeObjectURL = () => {};
// A plain capture class: extending jsdom's Blob would add its own (slow) string
// conversion and hide the exporter's real cost.
window.Blob = class {
  constructor(parts, options) {
    this.__parts = parts;
    this.type = options?.type || "";
    blobBytes = parts.reduce((n, p) => n + (typeof p === "string" ? p.length : p?.length || 0), 0);
  }
  get size() { return blobBytes; }
};

window.eval(source);
await new Promise((r) => setTimeout(r, 50));

const t0 = process.hrtime.bigint();
const rss0 = process.memoryUsage().rss;
let name;
for (const format of ["json", "txt"]) {
  const t = process.hrtime.bigint();
  name = await window.__arenaChatExport(id, format, "agentic");
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`${format.toUpperCase()}: ${ms.toFixed(0)} ms, output ${(blobBytes / 1e6).toFixed(1)} MB, ${name.slice(0, 60)}`);
}
const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
const rssPeak = (process.memoryUsage().rss - rss0) / 1e6;
console.log(`both formats: ${totalMs.toFixed(0)} ms; RSS delta ~${rssPeak.toFixed(0)} MB`);
console.log(`input record: ${(recordText.length / 1e6).toFixed(1)} MB`);
