// Batch export benchmark: compares the shipped 2.3.2 userscript with the
// newest one on the same fake arena.ai page and the same fake latency.
//
//   node tests/bench-batch.mjs                        # 48 chats, 700 ms per request
//   node tests/bench-batch.mjs --chats 219 --latency 1500
//   node tests/bench-batch.mjs --script "…-2.4.0.user.js"
//
// The point of the benchmark is network pacing, not CPU: every simulated
// GET /api/evaluation/{id} sleeps for --latency milliseconds, so the serial
// 2.3.2 loop (request + fixed 160 ms pause) can be compared with the parallel
// 2.4.0 pool directly. ZIP work is included in the measurement.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import * as fflate from "fflate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const CHAT_COUNT = Number(arg("chats", 48));
const LATENCY_MS = Number(arg("latency", 700));
const ONLY = arg("script", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listScripts() {
  if (ONLY) return [path.resolve(ONLY)];
  return fs
    .readdirSync(ROOT)
    .filter((name) => /Exporter-.*\.user\.js$/.test(name))
    .map((name) => ({ name, version: (name.match(/(\d+\.\d+\.\d+)/) || [])[1] || "0.0.0" }))
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
    .map(({ name }) => path.join(ROOT, name));
}

function makeChats(count) {
  const hex = "0123456789abcdef";
  return Array.from({ length: count }, (_, index) => {
    const id = `${hex[index % 16]}${hex[(index * 7) % 16]}9c4323-cbf3-7648-bf96-c1ae90af${String(index).padStart(4, "0")}`;
    return { type: "evaluation", id, title: `Bench chat ${index + 1}`, mode: "direct-battle", createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", archivedAt: index % 3 === 0 ? "2026-10-02T10:00:00.000Z" : null };
  });
}

function evaluationRecord(id, index) {
  return {
    id,
    userId: "11111111-2222-3333-4444-555555555555",
    title: `Bench chat ${index + 1}`,
    mode: "direct-battle",
    visibility: "private",
    lastMessageIds: [],
    archivedAt: index % 3 === 0 ? "2026-10-02T10:00:00.000Z" : null,
    deletedAt: null,
    deletionPendingProcessing: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-21T11:00:00.000Z",
    messages: Array.from({ length: 8 }, (_, i) => ({
      id: `${id}-m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} ${"lorem ipsum dolor sit amet ".repeat(40)}`,
      createdAt: "2026-09-20T10:00:00.000Z",
    })),
    maskedEvaluations: [],
    pairwiseFeedbacks: [],
    pointwiseFeedbacks: [],
    revealedModels: [],
  };
}

async function run(scriptPath, { format, parallel }) {
  const source = fs.readFileSync(scriptPath, "utf8");
  const version = (source.match(/@version\s+(\S+)/) || [])[1] || "?";
  const chats = makeChats(CHAT_COUNT);
  const byId = new Map(chats.map((chat, index) => [chat.id, index]));

  const dom = new JSDOM("<!doctype html><html><body><div id='app'>arena</div></body></html>", {
    url: "https://arena.ai/search",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  let inFlight = 0;
  let maxInFlight = 0;
  let requests = 0;

  window.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  window.fetch = async (url) => {
    const parsed = new URL(String(url), "https://arena.ai");
    requests += 1;
    if (parsed.pathname === "/api/history/unified") {
      const cursor = parsed.searchParams.get("cursor");
      const pageSize = Number(parsed.searchParams.get("limit") || 20);
      const start = cursor ? Number(cursor) : 0;
      const entries = chats.slice(start, start + pageSize);
      const next = start + entries.length;
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => ({
          entries,
          pagination: { hasMore: next < chats.length, cursor: next < chats.length ? String(next) : null, limit: pageSize },
        }),
        text: async () => "",
      };
    }
    const match = parsed.pathname.match(/^\/api\/evaluation\/([0-9a-f-]{36})$/);
    if (match) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await sleep(LATENCY_MS);
        const index = byId.get(match[1]);
        if (index === undefined) return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "" };
        const record = evaluationRecord(match[1], index);
        return { ok: true, status: 200, statusText: "OK", json: async () => JSON.parse(JSON.stringify(record)), text: async () => "" };
      } finally {
        inFlight -= 1;
      }
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ entries: [], pagination: { hasMore: false, cursor: null } }), text: async () => "<html></html>" };
  };
  window.fflate = { strToU8: fflate.strToU8, zipSync: fflate.zipSync, unzipSync: fflate.unzipSync };
  let zipBlob = null;
  window.URL.createObjectURL = (blob) => {
    zipBlob = blob;
    return "blob:bench";
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
  await new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else window.addEventListener("DOMContentLoaded", resolve, { once: true });
  });
  window.eval(source);
  const started = Date.now();
  while (!document.querySelector("#arena-chat-export-dock-btn") && Date.now() - started < 5000) await sleep(10);
  document.querySelector("#arena-chat-export-dock-btn").click();
  await sleep(20);
  const $ = (sel) => document.querySelector(sel);

  $('[data-role="fetch-history"]').click();
  while (!/Loaded \d+ conversations/.test($("#arena-chat-export-status").textContent) && Date.now() - started < 60000) await sleep(20);
  $('[data-role="select-all"]').click();
  await sleep(20);

  const parallelNode = $('[data-role="export-parallel"]');
  if (parallelNode && parallel) {
    parallelNode.value = String(parallel);
    parallelNode.dispatchEvent(new window.Event("change", { bubbles: true }));
  }

  const buttonRole =
    format === "both"
      ? "export-selected-both"
      : format === "txt"
        ? "export-selected-txt"
        : "export-selected-json";
  const before = process.memoryUsage().rss;
  const zipStartedAt = Date.now();
  $(`[data-role="${buttonRole}"]`).click();
  while (!$("#arena-chat-export-status").textContent.includes("Batch export finished") && Date.now() - zipStartedAt < 900000) {
    await sleep(50);
  }
  const elapsed = Date.now() - zipStartedAt;
  const rssDeltaMb = (process.memoryUsage().rss - before) / 1048576;

  let zipBytes = 0;
  let files = 0;
  if (zipBlob?.__parts) {
    const parts = zipBlob.__parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    zipBytes = total;
    files = Object.keys(fflate.unzipSync(merged)).length;
  }

  dom.window.close();
  return {
    version,
    script: path.basename(scriptPath),
    chats: CHAT_COUNT,
    format,
    parallel: parallelNode ? Number(parallelNode.value) : 1,
    elapsedMs: elapsed,
    perChatMs: elapsed / CHAT_COUNT,
    requests,
    maxInFlight,
    rssDeltaMb,
    zipBytes,
    files,
  };
}

const scripts = listScripts();
const runs = [];
for (const scriptPath of scripts) {
  const version = (fs.readFileSync(scriptPath, "utf8").match(/@version\s+(\S+)/) || [])[1] || "?";
  runs.push(await run(scriptPath, { format: "json" }));
  if (version.localeCompare("2.4.0", undefined, { numeric: true }) >= 0) {
    runs.push(await run(scriptPath, { format: "both", parallel: 3 }));
  }
}

console.log(`\nchats per run: ${CHAT_COUNT}, simulated latency per request: ${LATENCY_MS} ms\n`);
const header = ["version", "format", "parallel", "wall", "per chat", "evaluation GETs", "max in flight", "zip size"];
const rows = runs.map((r) => [
  r.version,
  r.format,
  String(r.parallel),
  `${(r.elapsedMs / 1000).toFixed(1)} s`,
  `${Math.round(r.perChatMs)} ms`,
  String(r.requests),
  String(r.maxInFlight),
  `${(r.zipBytes / 1048576).toFixed(2)} MB`,
]);
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) console.log(line(row));

const baseline = runs[0];
const newest = runs[runs.length - 1];
console.log(
  `\nspeed-up on identical work: ${(baseline.elapsedMs / newest.elapsedMs).toFixed(2)}x` +
    ` (${baseline.version}: ${(baseline.elapsedMs / 1000).toFixed(1)} s -> ${newest.version}: ${(newest.elapsedMs / 1000).toFixed(1)} s)`
);
