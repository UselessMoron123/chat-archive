// jsdom test suite for the Arena.ai chat exporter userscript.
//
//   npm install            # once, for jsdom + fflate
//   node tests/exporter.test.mjs [path/to/exporter.user.js]
//
// Without an argument the newest "*Exporter-*.user.js" in the repo root is used.
// The suite drives the real script in a fake arena.ai page and checks:
//   * archive scope handling: list scopes, archived badges, manifest, JSON/TXT
//     payloads, the window.__arenaChatExport console API;
//   * batching: parallel workers, JSON + TXT written in a single pass, real ZIP
//     contents (unzipped with fflate), retry on 5xx and request timeout;
//   * the "Export everything" one-click flow.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import * as fflate from "fflate";
import { unzipSync, strFromU8 } from "fflate";

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
const VERSION = (source.match(/@version\s+(\S+)/) || [])[1] || "0.0.0";
const IS_24 = VERSION.localeCompare("2.4.0", undefined, { numeric: true }) >= 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;
function check(label, condition, extra = "") {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
}

async function waitFor(predicate, label, timeout = 8000) {
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
// harness: fake arena.ai page with a fake API and real ZIP downloads
// ---------------------------------------------------------------------------
function createHarness({ entriesForCursor, evaluationFor, delayMs = 0, onRequest }) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="app">arena</div></body></html>`, {
    url: "https://arena.ai/search",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  const downloads = [];
  const stats = { maxInFlight: 0, inFlight: 0, attempts: new Map() };

  window.fetch = async (url, init) => {
    const href = String(url);
    calls.push(href);
    const parsed = new URL(href, "https://arena.ai");
    stats.attempts.set(href, (stats.attempts.get(href) || 0) + 1);
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      if (delayMs) await sleep(delayMs);
      if (onRequest) {
        const override = await onRequest({ url: href, parsed, attempt: stats.attempts.get(href), init });
        if (override) return override;
      }
      if (parsed.pathname === "/api/history/unified") {
        return jsonResponse(entriesForCursor(parsed.searchParams.get("cursor") || "", parsed.searchParams));
      }
      const evalMatch = parsed.pathname.match(/^\/api\/evaluation\/([0-9a-f-]{36})$/);
      if (evalMatch) {
        const record = evaluationFor(evalMatch[1]);
        if (!record) {
          return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "" };
        }
        return jsonResponse(record);
      }
      if (parsed.pathname.startsWith("/agent/") || parsed.pathname.startsWith("/c/")) {
        return textResponse("<html><body>no flight payload</body></html>");
      }
      throw new Error(`unexpected fetch ${href}`);
    } finally {
      stats.inFlight -= 1;
    }
  };

  // 2.3.2 and older pull fflate from a @require; supply the real library so
  // their zipSync path produces a genuine (readable) archive here.
  window.fflate = { strToU8: fflate.strToU8, zipSync: fflate.zipSync, unzipSync: fflate.unzipSync };

  window.URL.createObjectURL = (blob) => {
    downloads.push(blob);
    return `blob:fake-${downloads.length}`;
  };
  window.URL.revokeObjectURL = () => {};
  const OriginalBlob = window.Blob;
  window.Blob = class CapturingBlob extends OriginalBlob {
    constructor(parts, options) {
      super(parts, options);
      this.__parts = parts;
    }
  };

  return { window, calls, downloads, stats };
}

/** Read a downloaded ZIP blob (built by the exporter) into { name: text }. */
function readZip(download) {
  const parts = (download.__parts || []).map((part) =>
    typeof part === "string" ? new TextEncoder().encode(part) : part
  );
  const total = parts.reduce((n, part) => n + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  const entries = unzipSync(merged);
  const out = {};
  for (const [name, bytes] of Object.entries(entries)) out[name] = strFromU8(bytes);
  return out;
}

function readTextDownload(download) {
  return (download.__parts || []).map((part) => (typeof part === "string" ? part : strFromU8(part))).join("");
}

async function mountScript(window, scriptSource = source) {
  const document = window.document;
  await new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else window.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
  window.eval(scriptSource);
  await waitFor(() => document.querySelector("#arena-chat-export-dock-btn"), "GUI mount");
  document.querySelector("#arena-chat-export-dock-btn").click();
  await sleep(10);
}

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
// suite 1 — archived chats, scopes, payload formats
// ---------------------------------------------------------------------------
async function suiteArchiveScope() {
  console.log("\n# suite: archive scope");
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
    delayMs: 20,
    entriesForCursor: (cursor) => pages[cursor],
    evaluationFor: (id) => sampleEvaluation(id, { title: `Chat ${id.slice(0, 4)}`, archivedAt: archived.has(id) ? "2026-09-12T12:00:00.000Z" : null }),
  });
  const { window, calls, downloads, stats } = harness;
  await mountScript(window);
  const document = window.document;
  const $ = (sel) => document.querySelector(sel);

  const scopeNode = $('[data-role="history-scope"]');
  check("scope selector defaults to all", scopeNode?.value === "all");
  if (IS_24) {
    check("parallel selector defaults to 3", $('[data-role="export-parallel"]')?.value === "3");
  }

  $('[data-role="fetch-history"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Loaded"), "history fetch");
  check(
    IS_24 ? "list request asks for 50 items per page" : "list request asks for 20 items per page",
    calls[0].includes(IS_24 ? "limit=50" : "limit=20"),
    calls[0]
  );
  check(
    "all scope requests includeArchived and reports archived count",
    calls[0].includes("includeArchived=true") &&
      !calls[0].includes("archivedOnly") &&
      $("#arena-chat-export-status").textContent.includes("Loaded 5 conversations (3 archived)."),
    $("#arena-chat-export-status").textContent
  );
  check("pagination follows the cursor", calls.length === 2 && calls[1].includes("cursor=cursor-1"), calls[1] || "");
  check("all 5 conversations rendered", document.querySelectorAll('[data-role="history-list"] .item').length === 5);
  check(
    "3 archived rows carry a badge",
    document.querySelectorAll('[data-role="history-list"] .item[data-archived="true"]').length === 3 &&
      document.querySelectorAll('[data-role="history-list"] .badge').length === 3
  );

  downloads.length = 0;
  $('[data-role="download-list"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Conversation list saved"), "list save");
  const listPayload = JSON.parse(readTextDownload(downloads[downloads.length - 1]));
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

  // batch export: 2.4 writes JSON + TXT in one pass, older builds one format per ZIP
  downloads.length = 0;
  calls.length = 0;
  stats.maxInFlight = 0;
  scopeNode.value = "all";
  scopeNode.dispatchEvent(new window.Event("change", { bubbles: true }));
  $('[data-role="fetch-history"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Loaded 5 conversations"), "refetch all");
  $('[data-role="select-all"]').click();
  await sleep(10);

  if (IS_24) {
    downloads.length = 0;
    calls.length = 0;
    $('[data-role="export-selected-both"]').click();
    await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Batch export finished"), "batch both", 15000);
    const zip = readZip(downloads[downloads.length - 1]);
    const names = Object.keys(zip).sort();
    const jsonFiles = names.filter((n) => n.endsWith(".json") && n !== "manifest.json");
    const txtFiles = names.filter((n) => n.endsWith(".txt"));
    check("one ZIP holds both formats for every chat", jsonFiles.length === 5 && txtFiles.length === 5, JSON.stringify({ json: jsonFiles.length, txt: txtFiles.length }));
    const manifest = JSON.parse(zip["manifest.json"]);
    check("manifest lists both formats and the concurrency", manifest.formats?.join("+") === "json+txt" && manifest.concurrency === 3, JSON.stringify({ formats: manifest.formats, c: manifest.concurrency }));
    check("manifest export is complete", manifest.successCount === 5 && manifest.failedCount === 0);
    check("manifest carries archivedCount and listScope", manifest.archivedCount === 3 && manifest.listScope === "all", JSON.stringify({ a: manifest.archivedCount, s: manifest.listScope }));
    const records = jsonFiles.map((n) => JSON.parse(zip[n]));
    check(
      "archived record JSON keeps top-level archivedAt, active does not",
      records.some((r) => r.evaluation?.id === EVAL_B && r.archivedAt === "2026-09-12T12:00:00.000Z") &&
        records.some((r) => r.evaluation?.id === EVAL_A && !("archivedAt" in r))
    );
    const txtBodies = txtFiles.map((n) => zip[n]);
    check("TXT body is preserved in the ZIP", txtBodies.some((t) => t.includes("general kenobi")));
    check("archived TXT carries the Archived header", txtBodies.some((t) => /^Archived :/m.test(t)));
    check(
      "each chat was fetched exactly once for both formats",
      calls.filter((u) => u.includes("/api/evaluation/")).length === 5,
      `evaluation requests: ${calls.filter((u) => u.includes("/api/evaluation/")).length}`
    );
    check("workers ran in parallel", stats.maxInFlight >= 2, `max in flight: ${stats.maxInFlight}`);

    downloads.length = 0;
    await window.__arenaChatExport(EVAL_B, "both", "evaluation");
    check("console API supports 'both' (two files)", downloads.length === 2, `downloads: ${downloads.length}`);
    const legacy = JSON.parse(readTextDownload(downloads[0]));
    check("console API export still carries archivedAt", legacy.recordType === "evaluation" && legacy.archivedAt === "2026-09-12T12:00:00.000Z");
  } else {
    downloads.length = 0;
    calls.length = 0;
    $('[data-role="export-selected-json"]').click();
    await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Batch export finished"), "json batch", 15000);
    const jsonZip = readZip(downloads[downloads.length - 1]);
    const jsonFiles = Object.keys(jsonZip).filter((n) => n.endsWith(".json") && n !== "manifest.json");
    check("one ZIP holds every selected chat as JSON", jsonFiles.length === 5, JSON.stringify(Object.keys(jsonZip)));
    const manifest = JSON.parse(jsonZip["manifest.json"]);
    check("manifest marks JSON as the format", manifest.format === "json");
    check("manifest export is complete", manifest.successCount === 5 && manifest.failedCount === 0);
    check("manifest carries archivedCount and listScope", manifest.archivedCount === 3 && manifest.listScope === "all", JSON.stringify({ a: manifest.archivedCount, s: manifest.listScope }));
    const records = jsonFiles.map((n) => JSON.parse(jsonZip[n]));
    check(
      "archived record JSON keeps top-level archivedAt, active does not",
      records.some((r) => r.evaluation?.id === EVAL_B && r.archivedAt === "2026-09-12T12:00:00.000Z") &&
        records.some((r) => r.evaluation?.id === EVAL_A && !("archivedAt" in r))
    );

    downloads.length = 0;
    $('[data-role="export-selected-txt"]').click();
    await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Batch export finished"), "txt batch", 15000);
    const txtZip = readZip(downloads[downloads.length - 1]);
    const txtFiles = Object.keys(txtZip).filter((n) => n.endsWith(".txt"));
    const txtBodies = txtFiles.map((n) => txtZip[n]);
    check("one ZIP holds every selected chat as TXT", txtFiles.length === 5, JSON.stringify(Object.keys(txtZip)));
    check("TXT body is preserved in the ZIP", txtBodies.some((t) => t.includes("general kenobi")));
    check("archived TXT carries the Archived header", txtBodies.some((t) => /^Archived :/m.test(t)));

    downloads.length = 0;
    await window.__arenaChatExport(EVAL_B, "json", "evaluation");
    const legacy = JSON.parse(readTextDownload(downloads[0]));
    check("console API export still carries archivedAt", legacy.recordType === "evaluation" && legacy.archivedAt === "2026-09-12T12:00:00.000Z");
  }
}

// ---------------------------------------------------------------------------
// suite 2 — resilience: retries, timeouts
// ---------------------------------------------------------------------------
async function suiteResilience() {
  console.log("\n# suite: retries and timeouts");
  const entries = [
    { type: "evaluation", id: EVAL_A, title: "Flaky chat", mode: "direct-battle", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", archivedAt: null },
    { type: "evaluation", id: EVAL_B, title: "Broken chat", mode: "battle", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", archivedAt: null },
  ];
  let flakyAttempts = 0;
  const harness = createHarness({
    entriesForCursor: () => ({ entries, pagination: { hasMore: false, cursor: null, limit: 20 } }),
    evaluationFor: (id) => sampleEvaluation(id, { title: `Chat ${id.slice(0, 4)}`, archivedAt: null }),
    onRequest: ({ parsed, attempt, init }) => {
      const match = parsed.pathname.match(/^\/api\/evaluation\/([0-9a-f-]{36})$/);
      if (!match) return null;
      if (match[1] === EVAL_A) {
        flakyAttempts += 1;
        if (attempt === 1) {
          return { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}), text: async () => "busy" };
        }
        return null;
      }
      if (match[1] === EVAL_B) {
        // Hang until aborted: exercises the per-request timeout.
        return new Promise((resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("harness: exporter sent no abort signal"));
            return;
          }
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
          );
        });
      }
      return null;
    },
  });
  const { window, downloads } = harness;
  window.__arenaChatExportTimeoutMs = 150;
  await mountScript(window);
  const document = window.document;
  const $ = (sel) => document.querySelector(sel);

  $('[data-role="fetch-history"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Loaded 2 conversations"), "history");
  $('[data-role="select-all"]').click();
  await sleep(10);
  downloads.length = 0;
  const startedAt = Date.now();
  $('[data-role="export-selected-json"]').click();
  await waitFor(
    () => $("#arena-chat-export-status")?.textContent.includes("Batch export finished"),
    "resilient batch",
    30000
  );
  const elapsed = Date.now() - startedAt;
  const zip = readZip(downloads[downloads.length - 1]);
  const manifest = JSON.parse(zip["manifest.json"]);
  check("flaky chat succeeded after a retry", manifest.successfulExports.some((e) => e.conversationId === EVAL_A));
  check("retry actually happened (2 attempts)", flakyAttempts === 2, `attempts: ${flakyAttempts}`);
  check("hung chat failed with a timeout, batch still completed", manifest.failedCount === 1 && manifest.successCount === 1, JSON.stringify({ ok: manifest.successCount, failed: manifest.failedCount }));
  check("failed chat is listed in failedExports", manifest.failedExports[0]?.conversationId === EVAL_B);
  check("timeout was reported in the log (not silently dropped)", zip["manifest.json"].includes(EVAL_B));
  console.log(`      (resilience batch took ${elapsed} ms, timeout override 150 ms)`);
}

// ---------------------------------------------------------------------------
// suite 3 — export everything in one click
// ---------------------------------------------------------------------------
async function suiteExportEverything() {
  console.log("\n# suite: export everything");
  const entries = [
    { type: "evaluation", id: EVAL_A, title: "First", mode: "direct-battle", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", archivedAt: null },
    { type: "agentic", id: AGENT_A, title: "Second", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", archivedAt: "2026-10-02T10:00:00.000Z" },
  ];
  const harness = createHarness({
    entriesForCursor: () => ({ entries, pagination: { hasMore: false, cursor: null, limit: 20 } }),
    evaluationFor: (id) => sampleEvaluation(id, { title: `Chat ${id.slice(0, 4)}`, archivedAt: id === AGENT_A ? "2026-10-02T10:00:00.000Z" : null }),
  });
  const { window, downloads } = harness;
  await mountScript(window);
  const document = window.document;
  const $ = (sel) => document.querySelector(sel);

  const parallel = $('[data-role="export-parallel"]');
  parallel.value = "4";
  parallel.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("parallel selector is wired to the state", parallel.value === "4");

  downloads.length = 0;
  $('[data-role="export-all"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Everything exported"), "export everything", 15000);
  const zip = readZip(downloads[downloads.length - 1]);
  const names = Object.keys(zip);
  check(
    "one click produced both formats for every chat",
    names.filter((n) => n.endsWith(".json") && n !== "manifest.json").length === 2 &&
      names.filter((n) => n.endsWith(".txt")).length === 2,
    JSON.stringify(names)
  );
  const manifest = JSON.parse(zip["manifest.json"]);
  check("manifest records the one-click run", manifest.exportedEverything === true && manifest.selectedCount === 2, JSON.stringify({ e: manifest.exportedEverything, s: manifest.selectedCount }));
  check("manifest keeps the chosen concurrency", manifest.concurrency === 4, String(manifest.concurrency));
  check("archived chat is in the manifest", manifest.archivedCount === 1, String(manifest.archivedCount));
  check("status reports the totals", /Success: 2\. Failed: 0\./.test($("#arena-chat-export-status").textContent), $("#arena-chat-export-status").textContent);
}

// ---------------------------------------------------------------------------
// suite 3b — streaming ZIP with a large payload: the text must survive the
// incremental writer byte for byte (this is where a naive streaming writer
// would truncate).
// ---------------------------------------------------------------------------
async function suiteLargePayload() {
  console.log("\n# suite: streaming ZIP with a large chat");
  const bigLine = "lorem ipsum dolor sit amet ".repeat(80_000); // ~2.1 MB
  const harness = createHarness({
    entriesForCursor: () => ({
      entries: [{ type: "evaluation", id: EVAL_A, title: "Big chat", mode: "direct-battle", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", archivedAt: null }],
      pagination: { hasMore: false, cursor: null, limit: 50 },
    }),
    evaluationFor: () => {
      const record = sampleEvaluation(EVAL_A, { title: "Big chat", archivedAt: null });
      record.messages[1].content = bigLine;
      return record;
    },
  });
  const { window, downloads } = harness;
  await mountScript(window);
  const document = window.document;
  const $ = (sel) => document.querySelector(sel);

  await window.__arenaChatExport(EVAL_A, "json", "evaluation");
  const directJson = readTextDownload(downloads[downloads.length - 1]);
  await window.__arenaChatExport(EVAL_A, "txt", "evaluation");
  const directTxt = readTextDownload(downloads[downloads.length - 1]);
  check("large chat exported directly", directJson.length > 2_000_000 && directTxt.length > 2_000_000, `json ${directJson.length} B, txt ${directTxt.length} B`);

  downloads.length = 0;
  $('[data-role="fetch-history"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Loaded 1 conversations"), "big list");
  $('[data-role="select-all"]').click();
  await sleep(10);
  $('[data-role="export-selected-both"]').click();
  await waitFor(() => $("#arena-chat-export-status")?.textContent.includes("Batch export finished"), "big zip", 60000);

  const zip = readZip(downloads[downloads.length - 1]);
  const zipJsonName = Object.keys(zip).find((n) => n.endsWith(".json") && n !== "manifest.json");
  const zipTxtName = Object.keys(zip).find((n) => n.endsWith(".txt"));
  check("both large entries are inside the ZIP", Boolean(zipJsonName && zipTxtName));
  check("large TXT survives the streaming writer byte for byte", zip[zipTxtName] === directTxt, `${zip[zipTxtName]?.length} vs ${directTxt.length} B`);
  const stripExportedAt = (text) => { const parsed = JSON.parse(text); delete parsed.exportedAt; return JSON.stringify(parsed); };
  check("large JSON survives the streaming writer", stripExportedAt(zip[zipJsonName]) === stripExportedAt(directJson));
  const manifest = JSON.parse(zip["manifest.json"]);
  check("large export is reported as successful", manifest.successCount === 1 && manifest.failedCount === 0);
}

// ---------------------------------------------------------------------------
// suite 4 — format parity: the newest build must emit byte-identical payloads
// to the shipped 2.3.2 for the same conversation (volatile fields aside).
// ---------------------------------------------------------------------------
async function suiteFormatParity() {
  console.log("\n# suite: format parity with the shipped 2.3.2");
  const legacyPath = path.join(ROOT, "Arena.ai - LMSYS Arena Chat Exporter-2.3.2.user.js");
  if (!IS_24 || !fs.existsSync(legacyPath)) {
    console.log("      skipped (needs a 2.4.0+ script next to the 2.3.2 file)");
    return;
  }
  const legacySource = fs.readFileSync(legacyPath, "utf8");

  async function capture(scriptSource, format) {
    const harness = createHarness({
      entriesForCursor: () => ({ entries: [], pagination: { hasMore: false, cursor: null, limit: 20 } }),
      evaluationFor: () => sampleEvaluation(EVAL_A, { title: "Parity chat", archivedAt: "2026-09-12T12:00:00.000Z" }),
    });
    await mountScript(harness.window, scriptSource);
    await harness.window.__arenaChatExport(EVAL_A, format, "evaluation");
    return readTextDownload(harness.downloads[harness.downloads.length - 1]);
  }

  const stableJson = (text) => {
    const parsed = JSON.parse(text);
    delete parsed.exportedAt;
    delete parsed.exported_at;
    return JSON.stringify(parsed, null, 2);
  };

  const legacyJson = stableJson(await capture(legacySource, "json"));
  const newJson = stableJson(await capture(source, "json"));
  check("JSON payloads are identical (excluding exportedAt)", legacyJson === newJson, legacyJson === newJson ? "" : "payloads differ");

  const legacyTxt = await capture(legacySource, "txt");
  const newTxt = await capture(source, "txt");
  check("TXT payloads are byte-identical", legacyTxt === newTxt, legacyTxt === newTxt ? "" : `legacy ${legacyTxt.length} B vs new ${newTxt.length} B`);

  const legacyZip = await (async () => {
    const harness = createHarness({
      entriesForCursor: () => ({
        entries: [{ type: "evaluation", id: EVAL_A, title: "Parity chat", mode: "direct-battle", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-21T11:00:00.000Z", archivedAt: "2026-09-12T12:00:00.000Z" }],
        pagination: { hasMore: false, cursor: null, limit: 20 },
      }),
      evaluationFor: () => sampleEvaluation(EVAL_A, { title: "Parity chat", archivedAt: "2026-09-12T12:00:00.000Z" }),
    });
    await mountScript(harness.window, legacySource);
    const document = harness.window.document;
    document.querySelector('[data-role="fetch-history"]').click();
    await waitFor(() => document.querySelector("#arena-chat-export-status")?.textContent.includes("Loaded 1 conversations"), "legacy list");
    document.querySelector('[data-role="select-all"]').click();
    await sleep(10);
    document.querySelector('[data-role="export-selected-json"]').click();
    await waitFor(() => document.querySelector("#arena-chat-export-status")?.textContent.includes("Batch export finished"), "legacy zip");
    const zip = readZip(harness.downloads[harness.downloads.length - 1]);
    const fileName = Object.keys(zip).find((n) => n.endsWith(".json") && n !== "manifest.json");
    const manifest = JSON.parse(zip["manifest.json"]);
    return { record: zip[fileName], manifest };
  })();

  const newZip = await (async () => {
    const harness = createHarness({
      entriesForCursor: () => ({
        entries: [{ type: "evaluation", id: EVAL_A, title: "Parity chat", mode: "direct-battle", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-21T11:00:00.000Z", archivedAt: "2026-09-12T12:00:00.000Z" }],
        pagination: { hasMore: false, cursor: null, limit: 50 },
      }),
      evaluationFor: () => sampleEvaluation(EVAL_A, { title: "Parity chat", archivedAt: "2026-09-12T12:00:00.000Z" }),
    });
    await mountScript(harness.window, source);
    const document = harness.window.document;
    document.querySelector('[data-role="fetch-history"]').click();
    await waitFor(() => document.querySelector("#arena-chat-export-status")?.textContent.includes("Loaded 1 conversations"), "new list");
    document.querySelector('[data-role="select-all"]').click();
    await sleep(10);
    document.querySelector('[data-role="export-selected-json"]').click();
    await waitFor(() => document.querySelector("#arena-chat-export-status")?.textContent.includes("Batch export finished"), "new zip");
    const zip = readZip(harness.downloads[harness.downloads.length - 1]);
    const fileName = Object.keys(zip).find((n) => n.endsWith(".json") && n !== "manifest.json");
    const manifest = JSON.parse(zip["manifest.json"]);
    return { record: zip[fileName], manifest };
  })();

  check(
    "the per-chat record written into a batch ZIP is identical",
    stableJson(legacyZip.record) === stableJson(newZip.record)
  );
  const sharedManifestKeys = ["exporter", "version", "selectedCount", "archivedCount", "successCount", "failedCount", "listScope", "warnings"];
  const manifestDelta = sharedManifestKeys.filter(
    (key) => JSON.stringify(legacyZip.manifest[key]) !== JSON.stringify(newZip.manifest[key]) && key !== "version"
  );
  check("manifest keeps the 2.3.2 fields with the same values", manifestDelta.length === 0, manifestDelta.join(", "));
}

// ---------------------------------------------------------------------------
console.log(`script under test: ${path.relative(ROOT, SCRIPT_PATH)} (${VERSION})`);
await suiteArchiveScope();
if (IS_24) {
  await suiteResilience();
  await suiteExportEverything();
  await suiteLargePayload();
  await suiteFormatParity();
} else {
  console.log("\n# skipping 2.4-specific suites (parallel batching, retries, export everything)");
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
