// Offline end-to-end replay of a real export batch.
//
//   node tests/e2e-replay.mjs \
//     --list "latest try/arena-chat-list-all-2026-10-03T16-39-49-640Z.json" \
//     --baseline "latest try_json" \
//     --out /tmp/replay
//
// Arena.ai is never contacted: the saved conversation list drives
// /api/history/unified and the per-chat payloads are taken verbatim from a
// previous JSON export (the "baseline" ZIPs). The newest userscript still runs
// its complete real code path — list paging, parallel fetching, sanitising,
// JSON + TXT rendering, streaming ZIP — so the produced archive can be audited
// with the same tools used on a real batch:
//
//   python3 tools/audit_export.py --zips /tmp/replay --list "<the same list>"
//   python3 tools/audit_export.py --zips /tmp/replay --baseline "latest try_json"
//
// Agent Mode chats are skipped: their export scrapes /agent/{id} HTML and the
// recorded payload alone cannot be turned back into a Next.js flight stream.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { unzipSync, strFromU8 } from "fflate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const LIST_PATH = path.resolve(ROOT, arg("list", "latest try/arena-chat-list-all-2026-10-03T16-39-49-640Z.json"));
const BASELINE = path.resolve(ROOT, arg("baseline", "latest try_json"));
const OUT_DIR = path.resolve(arg("out", "/tmp/replay"));
const PARALLEL = Number(arg("parallel", 4));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newestScript() {
  const explicit = arg("script", null);
  if (explicit) return path.resolve(ROOT, explicit);
  const files = fs
    .readdirSync(ROOT)
    .filter((name) => /Exporter-.*\.user\.js$/.test(name))
    .map((name) => ({ name, version: (name.match(/(\d+\.\d+\.\d+)/) || [])[1] || "0" }))
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return path.join(ROOT, files[files.length - 1].name);
}

// ---------------------------------------------------------------- baseline
console.log(`list:     ${path.relative(ROOT, LIST_PATH)}`);
console.log(`baseline: ${path.relative(ROOT, BASELINE)}`);
const zipFiles = fs.readdirSync(BASELINE).filter((name) => name.endsWith(".zip")).map((name) => path.join(BASELINE, name));
const records = new Map();
for (const zipPath of zipFiles) {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.endsWith(".json") || name === "manifest.json") continue;
    const payload = JSON.parse(strFromU8(bytes));
    const record = payload.evaluation || payload.agent || payload.session || payload;
    const id = record?.id || payload?.evaluation?.id;
    if (id) records.set(String(id).toLowerCase(), { record, fileName: name, kind: payload.evaluation ? "evaluation" : "agent" });
  }
}
const evaluationRecords = [...records.values()].filter((entry) => entry.kind === "evaluation").length;
console.log(`records:  ${records.size} conversations from ${zipFiles.length} baseline ZIP(s) (${evaluationRecords} evaluation, ${records.size - evaluationRecords} agentic)`);

const savedList = JSON.parse(fs.readFileSync(LIST_PATH, "utf8"));
const allItems = Array.isArray(savedList) ? savedList : savedList.items || savedList.chats || savedList.conversations;
const replayable = allItems
  .map((item) => ({ ...item, id: String(item.id).toLowerCase() }))
  .filter((item) => records.get(item.id)?.kind === "evaluation");
const skipped = allItems.length - replayable.length;
console.log(`replay:   ${replayable.length} evaluation chats (${skipped} skipped: agentic or not in the baseline)`);

// ------------------------------------------------------------------ harness
const scriptPath = newestScript();
const source = fs.readFileSync(scriptPath, "utf8");
const version = (source.match(/@version\s+(\S+)/) || [])[1];
console.log(`script:   ${path.relative(ROOT, scriptPath)} (v${version}), Parallel ${PARALLEL}\n`);

const dom = new JSDOM("<!doctype html><html><body><div id='app'>arena</div></body></html>", {
  url: "https://arena.ai/search",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
const startedAt = Date.now();
let listRequests = 0;
let chatRequests = 0;
let inFlight = 0;
let maxInFlight = 0;

window.fetch = async (url) => {
  const parsed = new URL(String(url), "https://arena.ai");
  if (parsed.pathname === "/api/history/unified") {
    listRequests += 1;
    const cursor = Number(parsed.searchParams.get("cursor") || 0);
    const limit = Number(parsed.searchParams.get("limit") || 20);
    const slice = replayable.slice(cursor, cursor + limit);
    const next = cursor + slice.length;
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => ({
        entries: slice.map((item) => ({
          type: "evaluation",
          id: item.id,
          title: item.title,
          mode: item.mode || "unknown",
          createdAt: item.createdAt || "",
          updatedAt: item.updatedAt || "",
          archivedAt: item.archivedAt || null,
        })),
        pagination: { hasMore: next < replayable.length, cursor: next < replayable.length ? String(next) : null, limit },
      }),
      text: async () => "",
    };
  }
  const match = parsed.pathname.match(/^\/api\/evaluation\/([0-9a-f-]{36})$/);
  if (match) {
    chatRequests += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const found = records.get(match[1].toLowerCase());
      if (!found) return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "" };
      const record = found.record;
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => record,
        text: async () => "",
      };
    } finally {
      inFlight -= 1;
    }
  }
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ entries: [], pagination: { hasMore: false, cursor: null } }), text: async () => "<html></html>" };
};

let downloaded = null;
window.URL.createObjectURL = (blob) => {
  downloaded = blob;
  return "blob:replay";
};
window.URL.revokeObjectURL = () => {};
const OriginalBlob = window.Blob;
window.Blob = class CapturingBlob extends OriginalBlob {
  constructor(parts, options) {
    super(parts, options);
    this.__parts = parts;
  }
};

const document = window.document;
window.eval(source);
while (!document.querySelector("#arena-chat-export-dock-btn")) await sleep(10);
document.querySelector("#arena-chat-export-dock-btn").click();
await sleep(20);
const $ = (sel) => document.querySelector(sel);
const parallelNode = $('[data-role="export-parallel"]');
parallelNode.value = String(PARALLEL);
parallelNode.dispatchEvent(new window.Event("change", { bubbles: true }));

$('[data-role="export-all"]').click();
const exportStart = Date.now();
let lastStatus = "";
for (;;) {
  const status = $("#arena-chat-export-status")?.textContent || "";
  if (status !== lastStatus) {
    lastStatus = status;
    process.stdout.write(`\r${status.slice(0, 110).padEnd(112)}`);
  }
  if (status.includes("Everything exported") || status.includes("All selected chat exports failed")) break;
  if (Date.now() - exportStart > 45 * 60 * 1000) throw new Error("replay timed out");
  await sleep(200);
}
process.stdout.write("\n");
const elapsed = Date.now() - exportStart;

// ------------------------------------------------------------------- write
if (!downloaded?.__parts) throw new Error("no ZIP was produced");
const parts = downloaded.__parts.map((part) => (typeof part === "string" ? new TextEncoder().encode(part) : part));
const total = parts.reduce((sum, part) => sum + part.length, 0);
const merged = new Uint8Array(total);
let offset = 0;
for (const part of parts) {
  merged.set(part, offset);
  offset += part.length;
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, `arena-chat-export-json+txt-replay-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
fs.writeFileSync(outPath, merged);

const verified = unzipSync(merged);
const manifest = JSON.parse(strFromU8(verified["manifest.json"]));
console.log(`\nwall time:      ${(elapsed / 1000).toFixed(1)} s for ${manifest.selectedCount} chats (${(elapsed / manifest.selectedCount).toFixed(0)} ms per chat, Parallel ${manifest.concurrency})`);
console.log(`list requests:  ${listRequests} | chat requests: ${chatRequests} | max in flight: ${maxInFlight}`);
console.log(`ZIP:            ${path.relative(ROOT, outPath)} — ${(total / 1048576).toFixed(2)} MB, ${Object.keys(verified).length} entries`);
console.log(`manifest:       success ${manifest.successCount}, failed ${manifest.failedCount}, archived ${manifest.archivedCount}, formats ${manifest.formats.join("+")}`);
console.log(`\nnow audit it:\n  python3 tools/audit_export.py --zips "${path.relative(ROOT, OUT_DIR)}" --list "${path.relative(ROOT, LIST_PATH)}" --baseline "${path.relative(ROOT, BASELINE)}"`);
