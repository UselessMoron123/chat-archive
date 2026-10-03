// jsdom test suite for the Arena.ai chat exporter userscript.
//
//   npm install jsdom          # once, in the repo root or any parent dir
//   node tests/exporter.test.mjs [path/to/exporter.user.js]
//
// Without an argument the newest "*Exporter-*.user.js" in the repo root is used.
// The suite drives the real script in a fake arena.ai page and checks:
//   * archive scope handling (v2.3.2): list scopes, archived badges, manifest,
//     JSON/TXT payloads, the window.__arenaChatExport console API.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pickScript() {
  const arg = process.argv[2] || process.env.SCRIPT;
  if (arg) return path.resolve(arg);
  const candidates = fs
    .readdirSync(ROOT)
    .filter((name) => /Exporter-.*\.user\.js$/.test(name))
    .map((name) => ({ name, version: (name.match(/(\d+\.\d+\.\d+)/) || [])[1] || "0.0.0" }))
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  if (!candidates.length) throw new Error("no exporter userscript found in repo root");
  return path.join(ROOT, candidates[candidates.length - 1].name);
}

const SCRIPT_PATH = pickScript();
const source = fs.readFileSync(SCRIPT_PATH, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function check(label, condition, extra = "") {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
}

async function waitFor(predicate, label, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(20);
  }
}

function jsonResponse(data) {
  return {
    ok: true, status: 200, statusText: "OK",
    json: async () => JSON.parse(JSON.stringify(data)),
    text: async () => JSON.stringify(data),
  };
}
function textResponse(text) {
  return {
    ok: true, status: 200, statusText: "OK",
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// ---------------------------------------------------------------------------
// harness: fake arena.ai page with a fake history API and ZIP capture
// ---------------------------------------------------------------------------
function createHarness({ entriesForCursor, evaluationFor }) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="app">arena</div></body></html>`, {
    url: "https://arena.ai/search",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  const blobs = [];
  const state = { zipEntries: null };

  window.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    const parsed = new URL(href, "https://arena.ai");
    if (parsed.pathname === "/api/history/unified") {
      return jsonResponse(entriesForCursor(parsed.searchParams.get("cursor") || "", parsed.searchParams));
    }
    const evalMatch = parsed.pathname.match(/^\/api\/evaluation\/([0-9a-f-]{36})$/);
    if (evalMatch) {
      const record = evaluationFor(evalMatch[1]);
      if (!record) return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "" };
      return jsonResponse(record);
    }
    if (parsed.pathname.startsWith("/agent/") || parsed.pathname.startsWith("/c/")) {
      return textResponse("<html><body>no flight payload</body></html>");
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  window.fflate = {
    strToU8: (s) => new TextEncoder().encode(s),
    zipSync: (entries) => {
      state.zipEntries = entries;
      return new Uint8Array([1, 2, 3]);
    },
  };
  window.URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return `blob:fake-${blobs.length}`;
  };
  window.URL.revokeObjectURL = () => {};
  const OriginalBlob = window.Blob;
  window.Blob = class CapturingBlob extends OriginalBlob {
    constructor(parts, options) {
      super(parts, options);
      this.__parts = parts;
    }
  };

  return { window, calls, blobs, state };
}

async function mountScript(window) {
  const document = window.document;
  await new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else window.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
  window.eval(source);
  await waitFor(() => document.querySelector("#arena-chat-export-dock-btn"), "GUI mount");
  document.querySelector("#arena-chat-export-dock-btn").click();
  await sleep(10);
}

const zipJson = (window, state, name) => JSON.parse(new TextDecoder().decode(state.zipEntries[name]));
const zipFileNames = (state) => Object.keys(state.zipEntries).sort();

const EVAL_A = "019c4323-cbf3-7648-bf96-c1ae90af38cf"; // active chat
const EVAL_B = "019c3dcc-11d3-7739-841e-db79ba4bf808"; // archived chat
const EVAL_C = "019c4315-afd0-7b86-9f2f-d5eb25264ef9"; // archived chat
const AGENT_A = "01a1014c-c144-7924-902d-9f93a8ca22ca"; // archived agent chat
const AGENT_B = "01a1014c-bd83-773f-b055-b4f6d22c9f9e"; // active agent chat

function sampleEvaluation(id, { title, archivedAt }) {
  return {
    id,
    userId: "11111111-2222-3333-4444-555555555555",
    title,
    mode: "direct-battle",
    visibility: "private",
    lastMessageIds: [],
    archivedAt: archivedAt || null,
    deletedAt: null,
    deletionPendingProcessing: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-21T11:00:00.000Z",
    messages: [
      { id: `${id}-m1`, role: "user", content: "hello there", createdAt: "2026-09-20T10:00:00.000Z" },
      { id: `${id}-m2`, role: "assistant", content: "general kenobi", createdAt: "2026-09-20T10:00:05.000Z" },
    ],
    maskedEvaluations: [],
    pairwiseFeedbacks: [],
    pointwiseFeedbacks: [],
    revealedModels: [],
  };
}

// ---------------------------------------------------------------------------
// suite 1 — archived chats (v2.3.2 features)
// ---------------------------------------------------------------------------
async function suiteArchiveScope() {
  console.log("\n# suite: archive scope (v2.3.2)");
  const pages = {
    "": {
      entries: [
        { type: "evaluation", id: EVAL_A, title: "Active chat", mode: "direct-battle", createdAt: "2026-09-30T09:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z", archivedAt: null },
        { type: "agentic", id: AGENT_A, title: "Archived agent chat", createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z", archivedAt: "2026-09-03T12:00:00.000Z" },
      ],
      pagination: { hasMore: true, cursor: "cursor-1", limit: 20 },
    },
    "cursor-1": {
      entries: [
        { type: "evaluation", id: EVAL_B, title: "Archived chat B", mode: "battle", createdAt: "2026-09-10T09:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z", archivedAt: "2026-09-12T12:00:00.000Z" },
        { type: "evaluation", id: EVAL_C, title: "Archived chat C", mode: "battle", createdAt: "2026-09-13T09:00:00.000Z", updatedAt: "2026-09-14T10:00:00.000Z", archivedAt: "2026-09-15T12:00:00.000Z" },
        { type: "agentic", id: AGENT_B, title: "Active agent chat", createdAt: "2026-09-16T09:00:00.000Z", updatedAt: "2026-09-17T10:00:00.000Z", archivedAt: null },
      ],
      pagination: { hasMore: false, cursor: null, limit: 20 },
    },
  };
  const archived = new Set([EVAL_B, EVAL_C, AGENT_A]);

  const harness = createHarness({
    entriesForCursor: (cursor) => pages[cursor],
    evaluationFor: (id) => sampleEvaluation(id, { title: `Chat ${id.slice(0, 4)}`, archivedAt: archived.has(id) ? "2026-09-12T12:00:00.000Z" : null }),
  });
  const { window, calls, blobs, state } = harness;
  await mountScript(window);
  const document = window.document;
  const $ = (sel) => document.querySelector(sel);

  const scopeNode = $('[data-role="history-scope"]');
  check("scope selector exists and defaults to all", scopeSelectValue(scopeNode) === "all");

  $('[data-role="fetch-history"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Loaded"), "history fetch");
  check(
    "all scope requests includeArchived and reports archived count",
    calls[0].includes("includeArchived=true") &&
      !calls[0].includes("archivedOnly") &&
      $("#arena-chat-export-status").textContent.includes("Loaded 5 conversations (3 archived)."),
    calls[0]
  );
  check("pagination follows the cursor", calls.length === 2 && calls[1].includes("cursor=cursor-1"), calls[1] || "");
  check("all 5 conversations rendered", document.querySelectorAll('[data-role="history-list"] .item').length === 5);
  check(
    "3 archived rows carry a badge",
    document.querySelectorAll('[data-role="history-list"] .item[data-archived="true"]').length === 3 &&
      document.querySelectorAll('[data-role="history-list"] .badge').length === 3
  );

  blobs.length = 0;
  $('[data-role="download-list"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Conversation list saved"), "list save");
  const listPayload = JSON.parse(String(blobs[blobs.length - 1].__parts[0]));
  check(
    "saved list JSON counts archived chats",
    listPayload.scope === "all" && listPayload.counts.total === 5 && listPayload.counts.archived === 3 && listPayload.counts.active === 2,
    JSON.stringify(listPayload.counts)
  );

  scopeNode.value = "archived";
  scopeNode.dispatchEvent(new window.Event("change", { bubbles: true }));
  calls.length = 0;
  $('[data-role="fetch-history"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Loaded"), "archived fetch");
  check(
    "archived scope sends archivedOnly=true with includeArchived=false",
    calls[0].includes("archivedOnly=true") && calls[0].includes("includeArchived=false"),
    calls[0]
  );

  state.zipEntries = null;
  $('[data-role="select-all"]').click();
  await sleep(10);
  $('[data-role="export-selected-json"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Batch export finished"), "batch export", 8000);
  const manifest = zipJson(window, state, "manifest.json");
  check("manifest carries archivedCount and listScope", manifest.archivedCount === 3 && manifest.listScope === "archived", JSON.stringify({ a: manifest.archivedCount, s: manifest.listScope }));
  check("manifest export is complete", manifest.successCount === 5 && manifest.failedCount === 0);
  const exportedRecords = zipFileNames(state)
    .filter((n) => n.endsWith(".json") && n !== "manifest.json")
    .map((n) => zipJson(window, state, n));
  check(
    "archived record JSON keeps top-level archivedAt, active does not",
    exportedRecords.some((r) => r.evaluation?.id === EVAL_B && r.archivedAt === "2026-09-12T12:00:00.000Z") &&
      exportedRecords.some((r) => r.evaluation?.id === EVAL_A && !("archivedAt" in r))
  );

  state.zipEntries = null;
  $('[data-role="clear-selection"]').click();
  await sleep(10);
  const archivedRow = [...document.querySelectorAll('[data-role="history-list"] .item')].find((row) => row.getAttribute("data-archived") === "true");
  archivedRow.querySelector('input[type="checkbox"]').click();
  await sleep(10);
  $('[data-role="export-selected-txt"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Batch export finished"), "txt export", 8000);
  const txtName = zipFileNames(state).find((n) => n.endsWith(".txt"));
  const txt = new TextDecoder().decode(state.zipEntries[txtName]);
  check("TXT header marks the archive date and keeps the body", /^Archived :/m.test(txt) && txt.includes("general kenobi"), txtName);

  blobs.length = 0;
  await window.__arenaChatExport(EVAL_B, "json", "evaluation");
  const legacy = JSON.parse(String(blobs[blobs.length - 1].__parts[0]));
  check("console API still exports and includes archivedAt", legacy.recordType === "evaluation" && legacy.archivedAt === "2026-09-12T12:00:00.000Z");
}

function scopeSelectValue(node) {
  return node ? node.value : null;
}

// ---------------------------------------------------------------------------
console.log(`script under test: ${path.relative(ROOT, SCRIPT_PATH)} (${source.match(/@version\s+(\S+)/)[1]})`);
await suiteArchiveScope();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
