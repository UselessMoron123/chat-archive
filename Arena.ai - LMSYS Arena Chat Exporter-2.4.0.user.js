// ==UserScript==
// @name         Arena.ai / LMSYS Arena Chat Exporter
// @namespace    http://tampermonkey.net/
// @version      2.4.0
// @description  Export arena.ai, lmarena.ai and legacy LMSYS Arena chats (Agent Mode and archived chats included) as JSON and/or detailed TXT with recorded tool I/O; parallel batched export, retries and a self-contained ZIP writer
// @match        https://arena.ai/*
// @match        https://*.arena.ai/*
// @match        https://lmarena.ai/*
// @match        https://*.lmarena.ai/*
// @match        https://chat.lmsys.org/*
// @match        https://arena.lmsys.org/*
// @run-at       document-idle
// @license      GPLv3
// ==/UserScript==
// 2.3.2: archived chats can be listed and exported without unarchiving —
//        history scope selector (active / active+archived / archived only),
//        archived markers in the list, archivedAt in the manifest and TXT headers,
//        and a conversation-list JSON download.
// 2.4.0: much faster batches — chats are fetched in parallel (Parallel selector,
//        default 3), the fixed 160 ms pause is gone, requests have a timeout and
//        retry 429/5xx/timeout. JSON + TXT can be written in a single pass over
//        one ZIP ('Export everything'), the ZIP writer is streaming and embedded
//        (no CDN), the agent payload is no longer deep-cloned for redaction and
//        the history list asks for 50 items per page.

(function () {
  "use strict";

  const LOG_TAG = "[arena-chat-export]";
  const HISTORY_ENDPOINT = "/api/history/unified";
  const EVALUATION_ENDPOINT_PREFIX = "/api/evaluation/";
  const AGENT_PAGE_PREFIX = "/agent/";
  const CHAT_PAGE_PREFIX = "/c/";
  const EXPORTER_VERSION = "2.4.0";
  const DEFAULT_HISTORY_PAGE_SIZE = 50; // the history API accepts up to 50 per page
  const HISTORY_PAGE_GUARD = 200;
  const DEFAULT_CONCURRENCY = 3;
  const MAX_CONCURRENCY = 8;
  const WORKER_JITTER_MS = 80;
  const REQUEST_TIMEOUT_MS = 120000;
  const REQUEST_MAX_ATTEMPTS = 3;
  const RETRY_BACKOFF_MS = [800, 2500];
  const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

  const GUI_ROOT_ID = "arena-chat-export-gui-root";
  const GUI_DOCK_BUTTON_ID = "arena-chat-export-dock-btn";
  const GUI_PANEL_ID = "arena-chat-export-panel";
  const GUI_STATUS_ID = "arena-chat-export-status";

  const UUID_PATTERN =
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  const STRINGS = {
    unknown_error: "Unknown error",
    request_failed: "Request failed {status} {statusText}{suffix}",
    invalid_session_id: "Invalid conversation identifier.",
    unexpected_evaluation_shape: "The API did not return the expected conversation shape.",
    unknown_export_format: "Unknown export format: {format}",
    current_page_not_chat: "The current page is not a chat detail page.",
    zip_lib_missing: "ZIP library is not loaded, ZIP packaging is unavailable.",
    no_selected_items: "Select at least one conversation first.",
    zip_generation_failed: "ZIP generation failed. Try fewer chats or switch export format.",
    untitled: "(untitled)",
    empty_message: "(empty)",
    dock_primary: "Export",
    dock_secondary: "Chat",
    dock_aria_open: "Open chat export panel",
    panel_title: "arena chat export",
    close_aria: "Close",
    section_current: "Current chat",
    button_download_json: "Download JSON",
    button_download_txt: "Download TXT",
    section_history: "Conversation list",
    button_fetch_history: "Fetch list",
    helper_history:
      "Load the list first. Archived chats can be exported without unarchiving; selected exports are packed into one ZIP with a manifest. Parallel controls how many chats are fetched at once.",
    scope_label: "Scope",
    scope_active: "Active only",
    scope_all: "Active + archived",
    scope_archived: "Archived only",
    button_download_list: "Save list JSON",
    label_download_list: "Saving conversation list",
    list_download_done: "Conversation list saved ({count} items, {archived} archived).",
    no_history_items: "Load the conversation list first.",
    badge_archived: "archived",
    selected_count_archived: "{count} selected ({archived} archived)",
    button_select_all: "Select all",
    button_clear_selection: "Clear",
    selected_count: "{count} selected",
    history_empty: "No conversations loaded yet",
    button_export_selected_json: "Export selected JSON",
    button_export_selected_txt: "Export selected TXT",
    status_prefix: "Status: {message}",
    status_ready: "Ready. Download the current chat or load the list for batch export.",
    status_running: "{label}...",
    status_done: "{label} completed.",
    status_failed: "{label} failed: {message}",
    label_fetch_history: "Loading list",
    label_download_current: "Downloading current {format}",
    label_export_selected: "Exporting selected {format}",
    fetch_page_request: "Loading list... page {page}, loaded {count}",
    fetch_page_loaded: "Loaded page {page}. Conversations: {count}",
    fetch_complete: "Loaded {count} conversations ({archived} archived).",
    fetch_guard_hit:
      "Loaded {count} conversations ({archived} archived). The safety guard was hit; increase the guard if you still expect more.",
    current_download_done: "Current chat was downloaded as {format}.",
    zip_packing: "Packing {format} ZIP...",
    zip_packing_progress: "Packing {format} ZIP... {percent}%",
    batch_done_packaged_success_failed:
      "Batch export finished. ZIP ready. Success: {success}. Failed: {failed}.",
    batch_done_success_failed:
      "Batch export finished. Success: {success}. Failed: {failed}.",
    batch_done_packaged_success:
      "Batch export finished. ZIP ready. Success: {success}.",
    batch_done_success: "Batch export finished. Success: {success}.",
    batch_done_manifest_only:
      "All selected chat exports failed. A manifest-only ZIP was created (failed: {failed}).",
    selected_all_done: "All loaded conversations are selected.",
    cleared_selection_done: "Selection cleared.",
    gui_init_failed: "GUI initialization failed: missing required nodes.",
    attachment_warning:
      "Attachment files are not downloaded; included links may expire or require an active Arena session.",
    attachment_warning_txt:
      "Attachments: files are not downloaded; included links may expire or require an active Arena session.",
    tool_output_warning:
      "Tool outputs are preserved as recorded; the exporter does not re-run tools or retrieve omitted fetch_page chunks/read_file ranges or unavailable image bytes.",
    tool_output_warning_txt:
      "Tool outputs are preserved as recorded; omitted fetch_page chunks/read_file lines and unavailable image bytes are not retrieved again.",
    button_download_both: "Download JSON + TXT",
    button_export_selected_both: "Export selected JSON + TXT",
    button_export_all: "Export everything",
    label_export_all: "Exporting everything",
    parallel_label: "Parallel",
    status_eta_suffix: ", ~{left} left",
    status_failed_suffix: ", failed: {failed}",
    export_all_done: "Everything exported. Success: {success}. Failed: {failed}.",
    request_timeout: "Request timed out after {duration}",
  };

  function t(key, vars) {
    const text = STRINGS[key] || key;
    if (!vars) {
      return text;
    }
    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => {
      const value = vars[name];
      return value == null ? "" : String(value);
    });
  }

  function log(...args) {
    console.log(LOG_TAG, ...args);
  }

  function warn(...args) {
    console.warn(LOG_TAG, ...args);
  }

  function toErrorMessage(error) {
    if (!error) {
      return t("unknown_error");
    }
    if (typeof error === "string") {
      return error;
    }
    if (error instanceof Error) {
      return error.message || String(error);
    }
    return String(error);
  }

  function extractConversationId(text) {
    const source = String(text || "");
    const match = source.match(UUID_PATTERN);
    return match ? match[1].toLowerCase() : null;
  }

  function getConversationIdFromCurrentUrl() {
    const pathname = String(location.pathname || "");
    const match = pathname.match(
      /\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?c\/([0-9a-f-]{36})(?:\/|$)/i
    );
    return match ? match[1].toLowerCase() : null;
  }

  function getAgentIdFromCurrentUrl() {
    const pathname = String(location.pathname || "");
    const match = pathname.match(
      /\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?agent(?:s)?\/([0-9a-f-]{36})(?:\/|$)/i
    );
    return match ? match[1].toLowerCase() : null;
  }

  function isAgentHistoryItem(item) {
    const type = String(item?.type || "").toLowerCase();
    const mode = String(item?.mode || "").toLowerCase();
    const url = String(item?.url || item?.href || item?.path || "").toLowerCase();
    return (
      type === "agentic" ||
      type === "agent" ||
      mode === "agentic" ||
      mode === "agent" ||
      url.includes("/agent/")
    );
  }

  function sanitizeFileNamePart(text, maxLength) {
    const raw = String(text || "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    if (!raw) {
      return "untitled";
    }
    const compact = raw.replace(/[. ]+$/g, "");
    return compact.slice(0, maxLength || 60) || "untitled";
  }

  function truncateText(text, maxLength) {
    const source = String(text || "");
    if (source.length <= maxLength) {
      return source;
    }
    return `${source.slice(0, Math.max(0, maxLength - 1))}...`;
  }

  function formatUiTime(text) {
    const value = String(text || "").trim();
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatTextTime(text) {
    const value = String(text || "").trim();
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return (
      [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("-") +
      " " +
      [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join(":")
    );
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function safeReadText(response) {
    try {
      return await response.text();
    } catch (_error) {
      return "";
    }
  }

  function randomInt(maxExclusive) {
    return Math.floor(Math.random() * Math.max(1, maxExclusive));
  }

  function backoffDelay(attempt) {
    const base = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length) - 1] || 800;
    return base + randomInt(400);
  }

  function formatRequestTimeout(milliseconds) {
    const value = Math.max(0, Math.round(Number(milliseconds) || 0));
    return value >= 1000 ? `${Math.round(value / 1000)}s` : `${value}ms`;
  }

  function getRequestTimeoutMs() {
    const override = Number(window.__arenaChatExportTimeoutMs);
    return Number.isFinite(override) && override > 0 ? override : REQUEST_TIMEOUT_MS;
  }

  function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${pad2(seconds)}s` : `${seconds}s`;
  }

  async function fetchWithPolicy(url, options) {
    const { attempts: requestedAttempts, ...init } = options || {};
    const attempts = Math.max(1, Number(requestedAttempts) || REQUEST_MAX_ATTEMPTS);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const timeoutMs = getRequestTimeoutMs();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let timedOut = false;
      const timer = controller
        ? window.setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : null;
      try {
        const response = await fetch(url, {
          ...init,
          signal: controller ? controller.signal : undefined,
        });
        if (timer) window.clearTimeout(timer);
        if (RETRY_STATUSES.has(response.status) && attempt < attempts) {
          log("retrying", response.status, `attempt ${attempt}/${attempts}`, url);
          await wait(backoffDelay(attempt));
          continue;
        }
        return response;
      } catch (error) {
        if (timer) window.clearTimeout(timer);
        lastError = timedOut
          ? new Error(t("request_timeout", { duration: formatRequestTimeout(timeoutMs) }))
          : error;
        if (attempt < attempts) {
          log("retrying after error", toErrorMessage(lastError), `attempt ${attempt}/${attempts}`, url);
          await wait(backoffDelay(attempt));
          continue;
        }
      }
    }
    throw lastError || new Error(t("unknown_error"));
  }

  async function fetchJson(url) {
    const response = await fetchWithPolicy(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!response.ok) {
      const responseText = truncateText(await safeReadText(response), 300);
      const suffix = responseText ? ` - ${responseText}` : "";
      throw new Error(
        t("request_failed", {
          status: response.status,
          statusText: response.statusText,
          suffix,
        })
      );
    }
    return await response.json();
  }

  async function fetchEvaluationById(conversationId) {
    const id = extractConversationId(conversationId);
    if (!id) {
      throw new Error(t("invalid_session_id"));
    }
    return await fetchJson(`${location.origin}${EVALUATION_ENDPOINT_PREFIX}${id}`);
  }

  async function fetchHistoryList(pageGuard, options, hooks) {
    const optionsObject = options && typeof options === "object" ? options : {};
    const includeArchived = Boolean(optionsObject.includeArchived);
    const archivedOnly = Boolean(optionsObject.archivedOnly);
    const merged = [];
    const seenCursors = new Set();
    let cursor = null;
    let currentPage = 0;
    while (currentPage < pageGuard) {
      const nextPageNumber = currentPage + 1;
      hooks?.onPageRequest?.({
        page: nextPageNumber,
        totalCount: merged.length,
      });
      const params = new URLSearchParams();
      params.set("limit", String(DEFAULT_HISTORY_PAGE_SIZE));
      params.set("includeArchived", includeArchived ? "true" : "false");
      if (archivedOnly) {
        params.set("archivedOnly", "true");
      }
      if (cursor) {
        params.set("cursor", cursor);
        seenCursors.add(cursor);
      }
      const requestUrl = `${location.origin}${HISTORY_ENDPOINT}?${params.toString()}`;
      const payload = await fetchJson(requestUrl);
      const batch = Array.isArray(payload?.entries) ? payload.entries : [];
      merged.push(...batch);

      const hasMore = Boolean(payload?.pagination?.hasMore);
      const nextCursor =
        typeof payload?.pagination?.cursor === "string"
          ? payload.pagination.cursor
          : null;
      currentPage += 1;
      hooks?.onPageLoaded?.({
        page: currentPage,
        batchCount: batch.length,
        totalCount: merged.length,
        hasMore,
      });
      if (!hasMore || !nextCursor || seenCursors.has(nextCursor)) {
        break;
      }
      cursor = nextCursor;
    }
    return merged;
  }

  /**
   * Linearly scan HTML for all `self.__next_f.push([1, "..."])` string chunks.
   * Avoids regex backtracking limits on large RSC chunks and tolerates whitespace
   * or multiple statements inside a `<script>` tag.
   */
  function decodeNextFlightChunksFromHtml(html) {
    const source = String(html || "");
    const chunks = [];
    const marker = "self.__next_f.push(";
    let searchFrom = 0;

    while (searchFrom < source.length) {
      const pushIdx = source.indexOf(marker, searchFrom);
      if (pushIdx < 0) {
        break;
      }
      let i = pushIdx + marker.length;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (source[i] !== "[") {
        searchFrom = i;
        continue;
      }
      i += 1;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (source[i] !== "1") {
        searchFrom = i;
        continue;
      }
      i += 1;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (source[i] !== ",") {
        searchFrom = i;
        continue;
      }
      i += 1;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (source[i] !== '"') {
        searchFrom = i;
        continue;
      }
      const quoteStart = i;
      i += 1;
      let escaping = false;
      while (i < source.length) {
        const ch = source[i];
        if (escaping) {
          escaping = false;
        } else if (ch === "\\") {
          escaping = true;
        } else if (ch === '"') {
          break;
        }
        i += 1;
      }
      if (i < source.length && source[i] === '"') {
        const rawJsonLiteral = source.slice(quoteStart, i + 1);
        try {
          chunks.push(JSON.parse(rawJsonLiteral));
        } catch (error) {
          warn("failed to decode Next.js flight chunk", error);
        }
        searchFrom = i + 1;
      } else {
        break;
      }
    }
    return chunks;
  }

  function decodeNextFlightTextFromHtml(html) {
    return decodeNextFlightChunksFromHtml(html).join("");
  }

  function utf8ByteLengthOfCodePoint(codePoint) {
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
  }

  function readUtf8ByteLengthSegment(text, startIndex, byteLength) {
    let index = startIndex;
    let bytes = 0;
    const len = text.length;
    while (index < len && bytes < byteLength) {
      const codePoint = text.codePointAt(index);
      const charBytes = utf8ByteLengthOfCodePoint(codePoint);
      if (bytes + charBytes > byteLength) {
        break;
      }
      bytes += charBytes;
      index += codePoint > 0xffff ? 2 : 1;
    }

    // Verify if `index` aligns with the next Flight row header; self-heal if off by a few chars
    const nextRowPattern =
      /^(?:\r?\n)?[0-9a-f]{1,6}:(?:T[0-9a-f]+,|[A-Za-z]{0,3}[\[{"\-0-9tfn$])/i;
    if (index < len && !nextRowPattern.test(text.slice(index, index + 24))) {
      const winStart = Math.max(startIndex, index - 32);
      const winEnd = Math.min(len, index + 32);
      const windowStr = text.slice(winStart, winEnd);
      const boundaryMatch = windowStr.match(
        /(?:\r?\n)([0-9a-f]{1,6}:(?:T[0-9a-f]+,|[A-Za-z]{0,3}[\[{"]))|([0-9a-f]{1,6}:T[0-9a-f]+,)/i
      );
      if (boundaryMatch && boundaryMatch.index != null) {
        const leadingNewlineLen = boundaryMatch[0].startsWith("\r\n")
          ? 2
          : boundaryMatch[0].startsWith("\n") || boundaryMatch[0].startsWith("\r")
          ? 1
          : 0;
        index = winStart + boundaryMatch.index + leadingNewlineLen;
      }
    }

    return {
      text: text.slice(startIndex, index),
      endIndex: index,
    };
  }

  /**
   * Parse all `:T<hex>,` text records AND all `<id>:<json>` Flight rows from `flightText`.
   * Also returns `cleanedFlightText` with `:T` raw segments replaced by newlines so raw text
   * inside `:T` chunks can never interfere with JSON scanning.
   */
  function parseNextFlightStream(flightText) {
    const textRecords = {};
    const rowRecords = {};
    const cleanParts = [];
    const anyTPattern = /([0-9a-f]{1,8}):T([0-9a-f]+),/gi;
    let cursor = 0;
    let match;

    while ((match = anyTPattern.exec(flightText))) {
      const matchStart = match.index;
      if (matchStart > cursor) {
        cleanParts.push(flightText.slice(cursor, matchStart));
      }
      const id = match[1].toLowerCase();
      const byteLength = parseInt(match[2], 16);
      const startIndex = anyTPattern.lastIndex;
      const segment = readUtf8ByteLengthSegment(flightText, startIndex, byteLength);
      textRecords[id] = segment.text;
      rowRecords[id] = segment.text;
      cleanParts.push("\n");
      cursor = segment.endIndex;
      anyTPattern.lastIndex = segment.endIndex;
    }

    if (cursor < flightText.length) {
      cleanParts.push(flightText.slice(cursor));
    }

    const cleanedFlightText = cleanParts.join("");
    const lines = cleanedFlightText.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const rowMatch = line.match(/^([0-9a-f]{1,8}):(.*)$/i);
      if (!rowMatch) continue;
      const rowId = rowMatch[1].toLowerCase();
      const rhs = rowMatch[2].trim();
      if (!rhs || rowId in textRecords) continue;
      // Skip client module import rows (`I[...]`), hint rows (`HL[...]`), error/debug rows (`E{...}`)
      if (/^(?:I|HL|E|T|B)\b/.test(rhs) || rhs.startsWith("I[") || rhs.startsWith("HL[")) {
        continue;
      }

      const jsonPayloadMatch = rhs.match(/^([\["{\-0-9tfn].*)$/);
      if (jsonPayloadMatch) {
        try {
          const parsedRow = JSON.parse(jsonPayloadMatch[1]);
          // Skip React element tuples `["$", ...]` at top level when storing data rows
          if (Array.isArray(parsedRow) && parsedRow[0] === "$") {
            continue;
          }
          rowRecords[rowId] = parsedRow;
        } catch (_error) {
          // Ignore non-JSON RSC rows
        }
      }
    }

    return {
      textRecords,
      rowRecords,
      cleanedFlightText,
    };
  }

  function extractJsonBracketedAt(text, startIndex, openChar, closeChar) {
    if (text[startIndex] !== openChar) {
      return null;
    }
    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (char === "\\") {
          escaping = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === openChar) {
        depth += 1;
      } else if (char === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(startIndex, index + 1);
        }
      }
    }
    return null;
  }

  function extractJsonObjectAt(text, startIndex) {
    return extractJsonBracketedAt(text, startIndex, "{", "}");
  }

  function extractJsonArrayAt(text, startIndex) {
    return extractJsonBracketedAt(text, startIndex, "[", "]");
  }

  /**
   * Deeply resolves Next.js Flight references (`"$1a"`, `"$L1a"`, `"$@1a"`, `"$$"`, `"$D..."`, etc.)
   * against both `rowRecords` and `textRecords`.
   */
  function resolveNextFlightReferences(value, rowRecords, textRecords, activeStack) {
    const stack = activeStack || new Set();

    if (typeof value === "string") {
      if (value.startsWith("$$")) {
        return value.slice(1);
      }
      if (value === "$undefined") {
        return undefined;
      }
      if (value.startsWith("$D") && value.length > 2) {
        return value.slice(2);
      }
      // Only strip non-hex RSC reference prefixes (`L` or `@`), never `F` (which is a hex digit!)
      const match = value.match(/^\$(?:L|@)?([0-9a-f]+)$/i);
      if (match) {
        const refId = match[1].toLowerCase();
        if (textRecords && typeof textRecords[refId] === "string") {
          return textRecords[refId];
        }
        if (rowRecords && Object.prototype.hasOwnProperty.call(rowRecords, refId)) {
          const targetRow = rowRecords[refId];
          if (Array.isArray(targetRow) && targetRow[0] === "$") {
            return value;
          }
          if (stack.has(refId)) {
            return value;
          }
          const nextStack = new Set(stack);
          nextStack.add(refId);
          return resolveNextFlightReferences(
            targetRow,
            rowRecords,
            textRecords,
            nextStack
          );
        }
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        resolveNextFlightReferences(item, rowRecords, textRecords, stack)
      );
    }

    if (value && typeof value === "object") {
      const next = {};
      for (const [rawKey, item] of Object.entries(value)) {
        const key = rawKey.startsWith("$$") ? rawKey.slice(1) : rawKey;
        const resolvedItem = resolveNextFlightReferences(
          item,
          rowRecords,
          textRecords,
          stack
        );
        if (resolvedItem !== undefined) {
          next[key] = resolvedItem;
        }
      }
      return next;
    }

    return value;
  }

  function isLikelyAgentMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return false;
    }
    const role = String(msg.role || msg.speaker || msg.author || "").toLowerCase();
    const validRole =
      role === "user" ||
      role === "assistant" ||
      role === "system" ||
      role === "tool" ||
      role === "model" ||
      role === "data" ||
      role === "human" ||
      role === "ai";
    if (!validRole) {
      return false;
    }
    return (
      Array.isArray(msg.parts) ||
      msg.content !== undefined ||
      typeof msg.text === "string" ||
      Array.isArray(msg.toolInvocations) ||
      Array.isArray(msg.tool_calls) ||
      typeof msg.id === "string"
    );
  }

  function isLikelyAgentMessageArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) {
      return false;
    }
    const validCount = arr.filter(isLikelyAgentMessage).length;
    return validCount > 0 && validCount >= Math.ceil(arr.length * 0.5);
  }

  function normalizeAgentMessage(msg) {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    if (Array.isArray(msg.parts) && msg.parts.length > 0) {
      return msg;
    }
    const synthesizedParts = [];
    if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
      synthesizedParts.push({ type: "reasoning", text: msg.reasoning });
    }
    if (typeof msg.content === "string" && msg.content) {
      synthesizedParts.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (typeof item === "string") {
          synthesizedParts.push({ type: "text", text: item });
        } else if (item && typeof item === "object") {
          synthesizedParts.push(item);
        }
      }
    } else if (typeof msg.text === "string" && msg.text) {
      synthesizedParts.push({ type: "text", text: msg.text });
    }
    if (synthesizedParts.length > 0) {
      return {
        ...msg,
        parts: synthesizedParts,
      };
    }
    return msg;
  }

  function scoreAgentCandidate(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return -1;
    }
    const msgs = Array.isArray(candidate.messages) ? candidate.messages : [];
    if (!msgs.length) {
      if (candidate.session || candidate.agentSession || candidate.sandboxId) {
        return 1;
      }
      return -1;
    }
    if (!isLikelyAgentMessageArray(msgs)) {
      return -1;
    }
    let score = msgs.length * 10;
    if (msgs.some((m) => Array.isArray(m?.parts))) {
      score += 50;
    }
    if (candidate.session || candidate.title || candidate.id) {
      score += 20;
    }
    return score;
  }

  /**
   * Extract the Agent conversation payload from HTML using multiple strategies:
   * 1. Full RSC Flight row parsing + deep `$hex` reference resolution + object graph walk
   * 2. Property-level `"messages":[...]` / `"initialMessages":[...]` extraction anywhere in `flightText`
   *    (even when `"messages"` is not the first property of `{...}`)
   * 3. Legacy `{"messages":[` object scan
   */
  function extractAgentPayloadFromFlight(flightText) {
    const { textRecords, rowRecords, cleanedFlightText } =
      parseNextFlightStream(flightText);

    const candidates = [];
    const sessionMeta = {};
    const visited = new WeakSet();

    function inspectNode(node) {
      if (!node || typeof node !== "object") {
        return;
      }
      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      if (Array.isArray(node)) {
        if (isLikelyAgentMessageArray(node)) {
          candidates.push({ messages: node });
        }
        for (const item of node) {
          inspectNode(item);
        }
        return;
      }

      if (node.session && typeof node.session === "object" && !Array.isArray(node.session)) {
        Object.assign(sessionMeta, node.session);
      }
      if (typeof node.title === "string" && node.title.trim() && !sessionMeta.title) {
        sessionMeta.title = node.title.trim();
      }

      const msgKeys = [
        "messages",
        "initialMessages",
        "chatMessages",
        "conversationMessages",
        "turns",
      ];
      for (const key of msgKeys) {
        const val = node[key];
        if (Array.isArray(val) && (isLikelyAgentMessageArray(val) || (val.length === 0 && (node.session || node.sandboxId || node.sessionId)))) {
          candidates.push({
            ...node,
            messages: val,
          });
        }
      }

      for (const child of Object.values(node)) {
        inspectNode(child);
      }
    }

    // Strategy 1: Walk all resolved RSC Flight rows
    for (const rowId of Object.keys(rowRecords)) {
      if (rowId in textRecords) continue;
      try {
        const resolvedRow = resolveNextFlightReferences(
          rowRecords[rowId],
          rowRecords,
          textRecords,
          new Set([rowId])
        );
        inspectNode(resolvedRow);
      } catch (_error) {
        // Continue scanning other rows
      }
    }

    // Strategy 2: Scan for `"messages":` or `"initialMessages":` anywhere inside JSON objects
    // (fixes the v2.1 bug where `{"messages":[` had to be the very first key of the object)
    if (candidates.length === 0) {
      const propRegex = /"(?:messages|initialMessages|chatMessages|conversationMessages|turns)"\s*:\s*/g;
      for (const sourceText of [cleanedFlightText, flightText]) {
        let propMatch;
        propRegex.lastIndex = 0;
        while ((propMatch = propRegex.exec(sourceText))) {
          const matchIndex = propMatch.index;
          const valueStart = propRegex.lastIndex;

          // First try to find the enclosing `{...}` object so sibling keys (like `session`) are kept
          let searchBrace = matchIndex;
          while (searchBrace > 0 && matchIndex - searchBrace < 50000) {
            const openBraceIdx = sourceText.lastIndexOf("{", searchBrace - 1);
            if (openBraceIdx < 0) break;
            const objText = extractJsonObjectAt(sourceText, openBraceIdx);
            if (objText && openBraceIdx + objText.length > valueStart) {
              try {
                const rawObj = JSON.parse(objText);
                const resolvedObj = resolveNextFlightReferences(
                  rawObj,
                  rowRecords,
                  textRecords
                );
                inspectNode(resolvedObj);
                if (candidates.length > 0) break;
              } catch (_error) {
                // Keep searching outer braces or fall back to direct value extraction
              }
            }
            searchBrace = openBraceIdx;
          }
          if (candidates.length > 0) break;

          // Direct value extraction right after `"messages":`
          if (sourceText[valueStart] === "[") {
            const arrayText = extractJsonArrayAt(sourceText, valueStart);
            if (arrayText) {
              try {
                const rawArray = JSON.parse(arrayText);
                const resolvedArray = resolveNextFlightReferences(
                  rawArray,
                  rowRecords,
                  textRecords
                );
                if (isLikelyAgentMessageArray(resolvedArray)) {
                  candidates.push({ messages: resolvedArray });
                }
              } catch (_error) {
                // Keep scanning
              }
            }
          } else if (sourceText[valueStart] === '"') {
            const refMatch = sourceText
              .slice(valueStart, valueStart + 20)
              .match(/^"(\$(?:L|@)?[0-9a-f]+)"/i);
            if (refMatch) {
              const resolvedRef = resolveNextFlightReferences(
                refMatch[1],
                rowRecords,
                textRecords
              );
              if (isLikelyAgentMessageArray(resolvedRef)) {
                candidates.push({ messages: resolvedRef });
              }
            }
          }
        }
        if (candidates.length > 0) break;
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => scoreAgentCandidate(b) - scoreAgentCandidate(a));
    const best = candidates[0];
    const normalizedMessages = (Array.isArray(best.messages) ? best.messages : []).map(
      normalizeAgentMessage
    );

    return {
      ...(Object.keys(sessionMeta).length ? { session: sessionMeta } : {}),
      ...best,
      messages: normalizedMessages,
    };
  }

  function getTextFromAgentParts(parts) {
    return (Array.isArray(parts) ? parts : [])
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n\n");
  }

  function buildAgentTitle(agent) {
    const explicitTitle = String(agent?.title || agent?.session?.title || "").trim();
    if (explicitTitle) {
      return explicitTitle;
    }
    const firstUser = (Array.isArray(agent?.messages) ? agent.messages : []).find(
      (message) => String(message?.role || "").toLowerCase() === "user"
    );
    return truncateText(
      getTextFromAgentParts(firstUser?.parts) ||
        normalizeContent(firstUser?.content) ||
        "agent chat",
      80
    );
  }

  function sanitizeAgentForExport(agent) {
    if (!agent || typeof agent !== "object") {
      return agent;
    }
    const session = agent.session;
    if (!session || typeof session !== "object" || !session.publicAccessToken) {
      // No secret to strip: hand the record over as-is instead of copying
      // (a deep clone of a 20 MB record costs time and a second copy in memory).
      return agent;
    }
    const sanitizedSession = { ...session };
    delete sanitizedSession.publicAccessToken;
    sanitizedSession.publicAccessTokenRedacted = true;
    return { ...agent, session: sanitizedSession };
  }

  async function fetchAgentById(agentId, metadata) {
    const id = extractConversationId(agentId);
    if (!id) {
      throw new Error(t("invalid_session_id"));
    }

    const candidateUrls = [
      `${location.origin}${AGENT_PAGE_PREFIX}${id}`,
      `${location.origin}${CHAT_PAGE_PREFIX}${id}`,
    ];

    let lastError = null;
    for (const pageUrl of candidateUrls) {
      try {
        const response = await fetchWithPolicy(pageUrl, {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "text/html,application/xhtml+xml",
          },
        });
        if (!response.ok) {
          const responseText = truncateText(await safeReadText(response), 300);
          const suffix = responseText ? ` - ${responseText}` : "";
          throw new Error(
            t("request_failed", {
              status: response.status,
              statusText: response.statusText,
              suffix,
            })
          );
        }
        const html = await response.text();
        const flightText = decodeNextFlightTextFromHtml(html);
        const resolved = extractAgentPayloadFromFlight(flightText);
        if (!resolved) {
          throw new Error(t("unexpected_evaluation_shape"));
        }
        const agent = {
          id,
          type: "agentic",
          title: String(metadata?.title || "").trim() || undefined,
          createdAt: metadata?.createdAt || resolved?.session?.createdAt || "",
          updatedAt: metadata?.updatedAt || resolved?.session?.updatedAt || "",
          pageUrl: `${location.origin}${AGENT_PAGE_PREFIX}${id}`,
          ...resolved,
        };
        if (metadata?.title && String(metadata.title).trim()) {
          agent.title = String(metadata.title).trim();
        } else {
          agent.title = buildAgentTitle(agent);
        }
        return agent;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error(t("unexpected_evaluation_shape"));
  }

  function normalizeContent(content) {
    if (content == null) {
      return "";
    }
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (part && typeof part === "object") {
            if (typeof part.text === "string") {
              return part.text;
            }
            if (part.type === "image_url") {
              return `[image] ${part?.image_url?.url || ""}`;
            }
            return JSON.stringify(part, null, 2);
          }
          return String(part);
        })
        .join("\n");
    }
    if (typeof content === "object") {
      if (typeof content.text === "string") {
        return content.text;
      }
      if (Array.isArray(content.parts)) {
        return normalizeContent(content.parts);
      }
      return JSON.stringify(content, null, 2);
    }
    return String(content);
  }

  function formatSpeakerName(message, evaluation) {
    const role = String(message?.role || "").toLowerCase();
    if (role === "user") {
      return "User";
    }
    if (role === "assistant") {
      const position = String(message?.participantPosition || "").trim().toUpperCase();
      if (position === "A" || position === "B") {
        return `AI ${position}`;
      }
      if (evaluation?.mode === "battle") {
        return "AI";
      }
      return "AI";
    }
    if (role === "system") {
      return "System";
    }
    return role || "Unknown";
  }

  function formatAttachmentSummary(message) {
    const attachments = Array.isArray(message?.experimental_attachments)
      ? message.experimental_attachments
      : [];
    if (!attachments.length) {
      return "";
    }
    const details = attachments
      .map((att) => {
        const name = att?.name || att?.filename || "";
        const contentType = att?.contentType || att?.mediaType || "";
        const url = att?.url || "";
        return [name, contentType ? `(${contentType})` : "", url].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("; ");
    const countLabel = `${attachments.length} file${attachments.length > 1 ? "s" : ""} attached`;
    return details ? `${countLabel}: ${details}` : countLabel;
  }

  function getMessageParentKey(message) {
    const parentIds = Array.isArray(message?.parentMessageIds) ? message.parentMessageIds : [];
    return parentIds.join("|");
  }

  function getAssistantPositionRank(message) {
    const position = String(message?.participantPosition || "").trim().toUpperCase();
    if (position === "A") {
      return 0;
    }
    if (position === "B") {
      return 1;
    }
    return 9;
  }

  function getReadableTextMessages(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const ordered = [];

    for (let index = 0; index < source.length; index += 1) {
      const current = source[index];
      const currentRole = String(current?.role || "").toLowerCase();
      if (currentRole !== "assistant") {
        ordered.push(current);
        continue;
      }

      const chunk = [current];
      const parentKey = getMessageParentKey(current);
      while (index + 1 < source.length) {
        const next = source[index + 1];
        const nextRole = String(next?.role || "").toLowerCase();
        if (nextRole !== "assistant" || getMessageParentKey(next) !== parentKey) {
          break;
        }
        chunk.push(next);
        index += 1;
      }

      chunk.sort((left, right) => {
        const rankDiff = getAssistantPositionRank(left) - getAssistantPositionRank(right);
        if (rankDiff !== 0) {
          return rankDiff;
        }
        return 0;
      });

      ordered.push(...chunk);
    }

    return ordered;
  }

  function formatEvaluationAsText(evaluation) {
    const messages = getReadableTextMessages(evaluation?.messages);
    const lines = [];
    lines.push("============================================================");
    lines.push("arena.ai chat export");
    lines.push("============================================================");
    lines.push(`Title    : ${evaluation?.title || "(untitled)"}`);
    lines.push(`Mode     : ${evaluation?.mode || "unknown"}`);
    lines.push(`Started  : ${formatTextTime(evaluation?.createdAt)}`);
    lines.push(`Updated  : ${formatTextTime(evaluation?.updatedAt)}`);
    const archivedAt = getRecordArchivedAt(evaluation);
    if (archivedAt) {
      lines.push(`Archived : ${formatTextTime(archivedAt)}`);
    }
    lines.push(`Messages : ${messages.length}`);
    lines.push(`URL      : ${location.origin}/c/${evaluation?.id || ""}`);
    lines.push(t("attachment_warning_txt"));
    lines.push("");

    messages.forEach((message, index) => {
      const speaker = formatSpeakerName(message, evaluation);
      const time = formatTextTime(message?.createdAt);
      const reasoning =
        typeof message?.reasoning === "string" && message.reasoning.trim()
          ? `[reasoning]\n${message.reasoning.trim()}`
          : "";
      const mainContent = normalizeContent(message?.content);
      const combinedContent =
        [reasoning, mainContent].filter(Boolean).join("\n\n") || t("empty_message");
      const attachmentSummary = formatAttachmentSummary(message);

      lines.push("------------------------------------------------------------");
      lines.push(`Message  : ${index + 1}`);
      lines.push(`Speaker  : ${speaker}`);
      lines.push(`Time     : ${time}`);
      if (attachmentSummary) {
        lines.push(`Attach   : ${attachmentSummary}`);
      }
      lines.push("------------------------------------------------------------");
      lines.push(combinedContent);
      if (index !== messages.length - 1) {
        lines.push("");
      }
    });

    return `${lines.join("\n")}\n`;
  }

  function getRecordArchivedAt(record) {
    const value = record?.archivedAt ?? record?.session?.archivedAt;
    return typeof value === "string" && value.trim() ? value : "";
  }

  function isAgentExportObject(record) {
    return (
      record?.type === "agentic" ||
      (Array.isArray(record?.messages) &&
        record.messages.some((message) => Array.isArray(message?.parts)))
    );
  }

  function formatAgentPartAsText(part) {
    if (!part || typeof part !== "object") {
      return "";
    }

    const partType = String(part.type || "");

    function appendField(lines, label, value) {
      lines.push(`${label}:`);
      if (typeof value === "string") {
        lines.push(value.length ? value : '""');
        return;
      }
      const serialized = JSON.stringify(value, null, 2);
      lines.push(serialized === undefined ? String(value) : serialized);
    }

    function appendStructuredFields(lines, label, value) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0) {
          lines.push(`${label}: {}`);
          return;
        }
        for (const [key, fieldValue] of entries) {
          appendField(lines, `${label}.${key}`, fieldValue);
        }
        return;
      }
      appendField(lines, label, value);
    }

    function appendTruncationNotices(lines, value, pathLabel) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) =>
          appendTruncationNotices(lines, entry, `${pathLabel}[${index}]`)
        );
        return;
      }
      for (const [key, fieldValue] of Object.entries(value)) {
        const fieldPath = pathLabel ? `${pathLabel}.${key}` : key;
        if (/truncat/i.test(key) && fieldValue) {
          const normalizedKey = key.toLowerCase();
          if (normalizedKey === "stdout_truncated") {
            lines.push("[notice: stdout was truncated before export]");
          } else if (normalizedKey === "stderr_truncated") {
            lines.push("[notice: stderr was truncated before export]");
          } else {
            const detail = JSON.stringify(fieldValue) ?? String(fieldValue);
            lines.push(
              `[notice: upstream reported truncation at ${fieldPath}: ${detail}]`
            );
          }
        } else if (fieldValue && typeof fieldValue === "object") {
          appendTruncationNotices(lines, fieldValue, fieldPath);
        }
      }
    }

    function collectMetadata(sources, excludedKeys) {
      const metadata = {};
      for (const source of sources) {
        if (!source || typeof source !== "object" || Array.isArray(source)) {
          continue;
        }
        for (const [key, value] of Object.entries(source)) {
          if (!excludedKeys.has(key)) {
            metadata[key] = value;
          }
        }
      }
      return metadata;
    }

    function formatPartMetadata(lines, sources, excludedKeys) {
      sources.forEach((source, index) => {
        const metadata = collectMetadata([source], excludedKeys);
        if (Object.keys(metadata).length > 0) {
          const label =
            sources.length > 1
              ? index === 0
                ? "part.metadata"
                : "toolInvocation.metadata"
              : "metadata";
          appendStructuredFields(lines, label, metadata);
        }
      });
    }

    // `step-start` is a structural marker with no payload. Preserve any future
    // fields added to it rather than silently dropping them.
    if (partType === "step-start" && Object.keys(part).length === 1) {
      return "";
    }

    if (partType === "text" && typeof part.text === "string") {
      const lines = [part.text];
      formatPartMetadata(lines, [part], new Set(["type", "text"]));
      appendTruncationNotices(lines, part, "part");
      return lines.filter(Boolean).join("\n");
    }

    if (partType === "reasoning") {
      const reasoningText =
        typeof part.text === "string"
          ? part.text
          : typeof part.reasoning === "string"
          ? part.reasoning
          : "";
      const lines = [];
      if (reasoningText.trim()) {
        lines.push(`[reasoning]\n${reasoningText}`);
      }
      formatPartMetadata(
        lines,
        [part],
        new Set(["type", "text", "reasoning"])
      );
      appendTruncationNotices(lines, part, "part");
      return lines.join("\n");
    }

    if (partType === "file") {
      const lines = ["[file]"];
      appendStructuredFields(lines, "file", part);
      appendTruncationNotices(lines, part, "file");
      return lines.join("\n");
    }

    if (partType === "data-tool-results") {
      const lines = ["[tool-result: data-tool-results]"];
      if (part.data !== undefined) {
        appendStructuredFields(lines, "data", part.data);
        appendTruncationNotices(lines, part.data, "data");
      }
      formatPartMetadata(lines, [part], new Set(["type", "data"]));
      return lines.join("\n");
    }

    if (
      partType.startsWith("tool-") ||
      partType === "dynamic-tool" ||
      part.toolInvocation
    ) {
      const invocation =
        part.toolInvocation &&
        typeof part.toolInvocation === "object" &&
        !Array.isArray(part.toolInvocation)
          ? part.toolInvocation
          : part;
      const toolName = String(
        invocation.toolName || partType.replace(/^tool-/, "") || "tool"
      );
      const lines = [`[tool: ${toolName}]`];
      const nestedInvocation = invocation !== part;
      const metadataSources = nestedInvocation ? [part, invocation] : [part];
      const excludedKeys = new Set([
        "type",
        "input",
        "args",
        "output",
        "result",
      ]);
      if (nestedInvocation) excludedKeys.add("toolInvocation");
      formatPartMetadata(lines, metadataSources, excludedKeys);

      function appendToolCompletenessNotice(source) {
        if (!source || typeof source !== "object") return;
        const sourceToolName = String(source.toolName || toolName)
          .toLowerCase()
          .replace(/[\s-]+/g, "_");
        const input = source.input !== undefined ? source.input : source.args;
        const output = source.output !== undefined ? source.output : source.result;
        if (!output || typeof output !== "object") return;
        const outputStatus = String(output.status || "").toLowerCase();
        if (
          ["error", "failed", "failure"].includes(outputStatus) ||
          Boolean(output.error)
        ) {
          lines.push(
            "[notice: this tool call reported an error; see its recorded status/error fields]"
          );
        }

        if (sourceToolName === "fetch_page") {
          const chunkIndex = Number(output.chunkIndex ?? input?.chunkIndex);
          const totalChunks = Number(output.totalChunks);
          const hasMoreChunks =
            output.hasMore === true ||
            (Number.isFinite(chunkIndex) &&
              Number.isFinite(totalChunks) &&
              totalChunks > 0 &&
              chunkIndex + 1 < totalChunks);
          if (hasMoreChunks) {
            const chunkLabel =
              Number.isFinite(chunkIndex) &&
              Number.isFinite(totalChunks) &&
              totalChunks > 0
                ? ` (chunk ${chunkIndex + 1} of ${totalChunks})`
                : "";
            lines.push(
              `[notice: fetch_page response has more content${chunkLabel}; this exporter does not retrieve missing chunks]`
            );
          }
        }

        if (
          sourceToolName === "read_file" &&
          String(output.kind || "").toLowerCase() === "image" &&
          !output.content &&
          !output.data
        ) {
          lines.push(
            "[notice: read_file returned image metadata only; image bytes are not included in this tool response]"
          );
        }

        if (sourceToolName === "read_file") {
          const totalLines =
            output.lines == null ? Number.NaN : Number(output.lines);
          const requestedLimit =
            input?.limit == null ? Number.NaN : Number(input.limit);
          const requestedOffset =
            input?.offset == null ? 1 : Number(input.offset);
          const contentLineCount =
            typeof output.content === "string" && output.content.length
              ? output.content.split(/\r\n|\n|\r/).length
              : 0;
          const startLine =
            Number.isFinite(requestedOffset) && requestedOffset > 0
              ? Math.floor(requestedOffset)
              : 1;
          const returnedLineCount =
            Number.isFinite(requestedLimit) && requestedLimit > 0
              ? Math.floor(requestedLimit)
              : contentLineCount;
          const endLine = startLine + Math.max(0, returnedLineCount) - 1;
          const hasOmittedEarlierLines = startLine > 1;
          const hasOmittedLaterLines =
            Number.isFinite(totalLines) && totalLines > endLine;
          if (hasOmittedEarlierLines || hasOmittedLaterLines) {
            const lineSummary =
              returnedLineCount > 0
                ? Number.isFinite(totalLines)
                  ? `lines ${startLine}-${Math.min(endLine, totalLines)} of ${totalLines}`
                  : `starting at line ${startLine}`
                : Number.isFinite(totalLines)
                  ? `no content lines returned (reported total ${totalLines})`
                  : "no content lines returned";
            lines.push(
              `[notice: read_file returned an excerpt (${lineSummary}); other lines are only present if captured by another tool call]`
            );
          }
        }
      }

      function appendToolIO(source, prefix) {
        if (!source || typeof source !== "object") return;
        for (const key of ["input", "args", "output", "result"]) {
          if (source[key] === undefined) continue;
          appendStructuredFields(lines, `${prefix}${key}`, source[key]);
        }
      }

      appendToolIO(invocation, nestedInvocation ? "toolInvocation." : "");
      appendToolCompletenessNotice(invocation);
      if (nestedInvocation) {
        appendToolIO(part, "part.");
        appendToolCompletenessNotice(part);
      }
      appendTruncationNotices(lines, part, "part");
      return lines.join("\n");
    }

    // Keep unfamiliar future part types visible too. JSON remains the canonical
    // archive, but TXT should never quietly discard a new part payload.
    const lines = [`[part: ${partType || "unknown"}]`];
    appendTruncationNotices(lines, part, "part");
    lines.push(JSON.stringify(part, null, 2));
    return lines.join("\n");
  }

  function formatAgentAsText(agent) {
    const messages = Array.isArray(agent?.messages) ? agent.messages : [];
    const lines = [];
    lines.push("============================================================");
    lines.push("arena.ai agent chat export");
    lines.push("============================================================");
    lines.push(`Title    : ${agent?.title || "(untitled)"}`);
    lines.push(`Type     : agentic`);
    lines.push(`Started  : ${formatTextTime(agent?.createdAt)}`);
    lines.push(`Updated  : ${formatTextTime(agent?.updatedAt)}`);
    const archivedAt = getRecordArchivedAt(agent);
    if (archivedAt) {
      lines.push(`Archived : ${formatTextTime(archivedAt)}`);
    }
    lines.push(`Messages : ${messages.length}`);
    lines.push(
      `URL      : ${
        agent?.pageUrl || `${location.origin}${AGENT_PAGE_PREFIX}${agent?.id || ""}`
      }`
    );
    lines.push(t("attachment_warning_txt"));
    lines.push(t("tool_output_warning_txt"));
    lines.push("");

    messages.forEach((message, index) => {
      const role = String(message?.role || "unknown");
      const parts = Array.isArray(message?.parts) ? message.parts : [];
      const partsContent = parts.map(formatAgentPartAsText).filter(Boolean).join("\n\n");
      const fallbackContent = normalizeContent(message?.content || message?.text);
      const content = partsContent || fallbackContent || t("empty_message");
      lines.push("------------------------------------------------------------");
      lines.push(`Message  : ${index + 1}`);
      lines.push(`Speaker  : ${role}`);
      if (message?.createdAt) {
        lines.push(`Time     : ${formatTextTime(message.createdAt)}`);
      }
      lines.push("------------------------------------------------------------");
      lines.push(content);
      if (index !== messages.length - 1) {
        lines.push("");
      }
    });

    return `${lines.join("\n")}\n`;
  }

  function buildJsonExportObject(record) {
    if (isAgentExportObject(record)) {
      const agent = sanitizeAgentForExport(record);
      const archivedAt = getRecordArchivedAt(agent);
      return {
        exportedAt: new Date().toISOString(),
        source: location.origin,
        warnings: [t("attachment_warning"), t("tool_output_warning")],
        recordType: "agentic",
        conversationUrl:
          agent?.pageUrl || `${location.origin}${AGENT_PAGE_PREFIX}${agent?.id || ""}`,
        ...(archivedAt ? { archivedAt } : {}),
        agent,
      };
    }
    const archivedAt = getRecordArchivedAt(record);
    return {
      exportedAt: new Date().toISOString(),
      source: location.origin,
      warnings: [t("attachment_warning")],
      recordType: "evaluation",
      conversationUrl: `${location.origin}/c/${record?.id || ""}`,
      ...(archivedAt ? { archivedAt } : {}),
      evaluation: record,
    };
  }

  function buildFileName(record, extension) {
    const title = sanitizeFileNamePart(record?.title || "chat", 56);
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = isAgentExportObject(record) ? "arena-agent" : "arena-chat";
    return `${prefix}-${title}-${time}.${extension}`;
  }

  function downloadBlob(fileName, mimeType, content) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  function buildZipFileName(formats, options) {
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    const list = (Array.isArray(formats) ? formats : [formats]).filter(Boolean);
    const suffix = list.length ? list.join("+") : "json";
    const base = String(options?.zipFileNamePrefix || "").trim() || "arena-chat-export";
    return `${base}-${suffix}-${time}.zip`;
  }

  function getExportPayload(record, format) {
    if (!record || typeof record !== "object" || !record.id) {
      throw new Error(t("unexpected_evaluation_shape"));
    }
    if (format === "json") {
      const fileName = buildFileName(record, "json");
      const jsonText = `${JSON.stringify(buildJsonExportObject(record), null, 2)}\n`;
      return {
        fileName,
        mimeType: "application/json;charset=utf-8",
        textContent: jsonText,
      };
    }
    if (format === "txt") {
      const fileName = buildFileName(record, "txt");
      return {
        fileName,
        mimeType: "text/plain;charset=utf-8",
        textContent: isAgentExportObject(record)
          ? formatAgentAsText(record)
          : formatEvaluationAsText(record),
      };
    }
    throw new Error(t("unknown_export_format", { format }));
  }

  async function exportConversation(conversationId, format) {
    const evaluation = await fetchEvaluationById(conversationId);
    const payload = getExportPayload(evaluation, format);
    downloadBlob(payload.fileName, payload.mimeType, payload.textContent);
    return payload.fileName;
  }

  function applyHistoryMetadata(record, item) {
    if (!record || typeof record !== "object" || !item || typeof item !== "object") {
      return record;
    }
    if (typeof item.archivedAt === "string" && item.archivedAt.trim() && !getRecordArchivedAt(record)) {
      record.archivedAt = item.archivedAt;
    }
    if (!record.title && item.title) {
      record.title = String(item.title);
    }
    return record;
  }

  async function fetchExportRecord(item) {
    const id = extractConversationId(item?.id || item);
    if (!id) {
      throw new Error(t("invalid_session_id"));
    }
    const isAgent = isAgentHistoryItem(item);
    let record;
    if (isAgent) {
      try {
        record = await fetchAgentById(id, item);
      } catch (agentError) {
        try {
          record = await fetchEvaluationById(id);
        } catch (_evalError) {
          throw agentError;
        }
      }
    } else {
      try {
        record = await fetchEvaluationById(id);
      } catch (evalError) {
        try {
          record = await fetchAgentById(id, item);
        } catch (_agentError) {
          throw evalError;
        }
      }
    }
    return applyHistoryMetadata(record, item);
  }

  function downloadFormats(record, format) {
    const requested = String(format || "json").toLowerCase();
    const formats = requested === "both" ? ["json", "txt"] : [requested];
    const fileNames = [];
    for (const current of formats) {
      const payload = getExportPayload(record, current);
      downloadBlob(payload.fileName, payload.mimeType, payload.textContent);
      fileNames.push(payload.fileName);
    }
    return fileNames.length === 1 ? fileNames[0] : fileNames;
  }

  async function exportHistoryItem(item, format) {
    const record = await fetchExportRecord(item);
    return downloadFormats(record, format);
  }

  async function exportCurrentConversation(format) {
    const evaluationId = getConversationIdFromCurrentUrl();
    if (evaluationId) {
      return await exportHistoryItem({ id: evaluationId, type: "evaluation" }, format);
    }
    const agentId = getAgentIdFromCurrentUrl();
    if (agentId) {
      return await exportHistoryItem({ id: agentId, type: "agentic" }, format);
    }
    throw new Error(t("current_page_not_chat"));
  }

  function getZipLib() {
    if (EMBEDDED_FFLATE && typeof EMBEDDED_FFLATE.zipSync === "function") {
      return EMBEDDED_FFLATE;
    }
    if (typeof window.fflate === "object" && window.fflate) {
      return window.fflate;
    }
    if (typeof fflate === "object" && fflate) {
      return fflate;
    }
    throw new Error(t("zip_lib_missing"));
  }

  function normalizeConcurrency(value) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 1) {
      return 1;
    }
    return Math.min(number, MAX_CONCURRENCY);
  }

  async function runPool(total, concurrency, worker) {
    const limit = Math.max(1, Math.min(normalizeConcurrency(concurrency), Math.max(1, total)));
    let nextIndex = 0;
    const runners = [];
    for (let slot = 0; slot < limit; slot += 1) {
      runners.push(
        (async () => {
          for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= total) {
              return;
            }
            await worker(index);
          }
        })()
      );
    }
    await Promise.all(runners);
  }

  function uniqueArchiveName(usedNames, desired) {
    let nextName = desired;
    if (usedNames.has(nextName)) {
      const dotIndex = nextName.lastIndexOf(".");
      const baseName = dotIndex > 0 ? nextName.slice(0, dotIndex) : nextName;
      const extension = dotIndex > 0 ? nextName.slice(dotIndex) : "";
      let suffix = 2;
      while (usedNames.has(`${baseName}-${suffix}${extension}`)) {
        suffix += 1;
      }
      nextName = `${baseName}-${suffix}${extension}`;
    }
    usedNames.add(nextName);
    return nextName;
  }

  /**
   * Streaming ZIP writer: each file is compressed as soon as it is ready, so
   * the batch never holds all uncompressed texts *and* the archive at once.
   * Falls back to zipSync when the loaded library has no streaming API.
   */
  function createZipWriter(zipLib, options) {
    const level = Number.isFinite(Number(options?.compressionLevel))
      ? Number(options.compressionLevel)
      : 6;
    const supportsStreaming =
      typeof zipLib.Zip === "function" && typeof zipLib.ZipDeflate === "function";
    if (!supportsStreaming) {
      const entries = {};
      return {
        streaming: false,
        add(name, text) {
          entries[name] = zipLib.strToU8(text);
        },
        finish() {
          return zipLib.zipSync(entries, { level });
        },
      };
    }
    const chunks = [];
    let failure = null;
    const zip = new zipLib.Zip((error, chunk) => {
      if (error) {
        failure = error;
        return;
      }
      if (chunk) {
        chunks.push(chunk);
      }
    });
    return {
      streaming: true,
      add(name, text) {
        const file = new zipLib.ZipDeflate(name, { level });
        zip.add(file);
        file.push(zipLib.strToU8(text), true);
      },
      finish() {
        zip.end();
        if (failure) {
          throw failure;
        }
        return new Blob(chunks, { type: "application/zip" });
      },
    };
  }

  function getHistoryItemKey(item) {
    const id = extractConversationId(item?.id || item);
    const type = isAgentHistoryItem(item) ? "agentic" : "evaluation";
    return id ? `${type}:${id}` : "";
  }

  function normalizeExportItems(items) {
    const normalized = [];
    const dedupe = new Set();
    for (const value of items || []) {
      const id = extractConversationId(value?.id || value);
      if (!id) {
        continue;
      }
      const type = isAgentHistoryItem(value) ? "agentic" : "evaluation";
      const key = `${type}:${id}`;
      if (dedupe.has(key)) {
        continue;
      }
      dedupe.add(key);
      normalized.push({
        ...(value && typeof value === "object" ? value : {}),
        id,
        type,
      });
    }
    return normalized;
  }

  async function exportBatchConversations(conversationItems, formats, hooks, manifestExtras, options) {
    const items = normalizeExportItems(conversationItems);
    if (!items.length) {
      throw new Error(t("no_selected_items"));
    }
    const requestedFormats = Array.isArray(formats) ? formats : [formats];
    const formatList = requestedFormats
      .map((value) => String(value || "").toLowerCase())
      .filter(
        (value, index, all) => (value === "json" || value === "txt") && all.indexOf(value) === index
      );
    if (!formatList.length) {
      throw new Error(t("unknown_export_format", { format: String(requestedFormats) }));
    }

    const zipLib = getZipLib();
    const writer = createZipWriter(zipLib, options);
    const concurrency = normalizeConcurrency(options?.concurrency ?? DEFAULT_CONCURRENCY);
    const archivedCount = items.filter((item) => Boolean(item?.archivedAt)).length;
    const usedNames = new Set();
    const outcomes = new Array(items.length);
    const startedAt = Date.now();
    let completed = 0;
    let successCount = 0;
    let failedCount = 0;

    await runPool(items.length, concurrency, async (index) => {
      // Spread the workers slightly so parallel requests do not fire in lockstep.
      await wait(randomInt(WORKER_JITTER_MS));
      const item = items[index];
      try {
        const record = await fetchExportRecord(item);
        const files = {};
        for (const format of formatList) {
          const payload = getExportPayload(record, format);
          const name = uniqueArchiveName(usedNames, payload.fileName);
          writer.add(name, payload.textContent);
          files[format] = name;
        }
        outcomes[index] = {
          ok: true,
          entry: {
            fileName: files[formatList[0]],
            files,
            conversationId: String(record?.id || item?.id || ""),
            recordType: isAgentExportObject(record) ? "agentic" : "evaluation",
            title: String(record?.title || item?.title || "").trim() || null,
            archivedAt: item?.archivedAt || null,
          },
        };
        successCount += 1;
      } catch (error) {
        failedCount += 1;
        outcomes[index] = {
          ok: false,
          entry: {
            conversationId: String(item?.id || ""),
            recordType: item?.type || "unknown",
            title: String(item?.title || "").trim() || null,
            archivedAt: item?.archivedAt || null,
          },
        };
        warn("item export failed", item?.id, item?.type, item?.title, error);
        hooks?.onItemError?.({
          index: index + 1,
          total: items.length,
          item,
          error,
        });
      } finally {
        completed += 1;
        hooks?.onProgress?.({
          index: completed,
          total: items.length,
          successCount,
          failedCount,
          elapsedMs: Date.now() - startedAt,
        });
      }
    });

    const successfulExports = outcomes
      .filter((outcome) => outcome?.ok)
      .map((outcome) => outcome.entry);
    const failedExports = outcomes
      .filter((outcome) => outcome && !outcome.ok)
      .map((outcome) => outcome.entry);

    const manifest = {
      exporter: "Arena.ai / LMSYS Arena Chat Exporter",
      version: EXPORTER_VERSION,
      exportedAt: new Date().toISOString(),
      format: formatList.length === 1 ? formatList[0] : formatList.join("+"),
      formats: formatList,
      concurrency,
      selectedCount: items.length,
      archivedCount,
      ...(manifestExtras && typeof manifestExtras === "object" ? manifestExtras : {}),
      successCount,
      failedCount,
      selectedItems: items.map((item) => ({
        conversationId: String(item?.id || ""),
        recordType: item?.type || "unknown",
        title: String(item?.title || "").trim() || null,
        archivedAt: item?.archivedAt || null,
      })),
      successfulExports,
      failedExports,
      warnings: [t("attachment_warning"), t("tool_output_warning")],
    };
    writer.add("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

    hooks?.onZipProgressStart?.({ total: items.length, successCount, failedCount });
    let zipContent;
    try {
      hooks?.onZipProgress?.({ percent: 90 });
      zipContent = writer.finish();
      hooks?.onZipProgress?.({ percent: 100 });
    } catch (error) {
      warn("zip generation failed", error);
      throw new Error(t("zip_generation_failed"));
    }
    const zipFileName = buildZipFileName(formatList, options);
    downloadBlob(zipFileName, "application/zip", zipContent);
    return {
      total: items.length,
      successCount,
      failedCount,
      packaged: true,
      manifestOnly: successCount === 0,
      fileName: zipFileName,
      streaming: Boolean(writer.streaming),
    };
  }

  // ------------------------------------------------------------------
  // fflate 0.8.2 — MIT license — https://github.com/101arrowz/fflate
  // Embedded so that ZIP packaging keeps working when the CDN is unreachable.
  // The UMD bundle is invoked with local `module`/`exports` bindings, so it
  // returns the library object instead of writing a global one.
  // ------------------------------------------------------------------
  const EMBEDDED_FFLATE = (function () {
    const moduleObject = { exports: {} };
    (function (module, exports) {
      !function(f){typeof module!='undefined'&&typeof exports=='object'?module.exports=f():typeof define!='undefined'&&define.amd?define(f):(typeof self!='undefined'?self:this).fflate=f()}(function(){var _e={};"use strict";_e.deflate=zt,_e.deflateSync=kt,_e.inflate=At,_e.inflateSync=Tt,_e.gzip=It,_e.compress=It,_e.gzipSync=Ut,_e.compressSync=Ut,_e.gunzip=Zt,_e.gunzipSync=qt,_e.zlib=Lt,_e.zlibSync=Bt,_e.unzlib=Nt,_e.unzlibSync=Pt,_e.gzip=It,_e.compress=It,_e.decompress=Jt,_e.decompressSync=Kt,_e.strToU8=nn,_e.strFromU8=rn,_e.zip=dn,_e.zipSync=gn,_e.unzip=zn,_e.unzipSync=kn;var t=(typeof module!='undefined'&&typeof exports=='object'?function(_f){"use strict";var e,r,t,n=";var __w=require('worker_threads');__w.parentPort.on('message',function(m){onmessage({data:m})}),postMessage=function(m,t){__w.parentPort.postMessage(m,t)},close=process.exit;self=global";try{e=require("worker_threads"),r=e.Worker,t=e.isMarkedAsUntransferable}catch(e){}exports.default=r?function(e,o,a,s,u){var i=!1,l=new r(e+n,{eval:!0}).on("error",function(e){return u(e,null)}).on("message",function(e){return u(null,e)}).on("exit",function(e){e&&!i&&u(Error("exited with code "+e),null)});return t&&(s=s.filter(function(e){return!t(e)})),l.postMessage(a,s),l.terminate=function(){return i=!0,r.prototype.terminate.call(l)},l}:function(e,r,t,n,o){setImmediate(function(){return o(Error("async operations unsupported - update to Node 12+ (or Node 10-11 with the --experimental-worker CLI flag)"),null)});var a=function(){};return{terminate:a,postMessage:a}};return _f}:function(_f){"use strict";var e={};_f.default=function(r,t,s,a,n){var o=new Worker(e[t]||(e[t]=URL.createObjectURL(new Blob([r+';addEventListener("error",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})'],{type:"text/javascript"}))));return o.onmessage=function(e){var r=e.data,t=r.$e$;if(t){var s=Error(t[0]);s.code=t[1],s.stack=t[2],n(s,null)}else n(null,r)},o.postMessage(s,a),o};return _f})({}),n=Uint8Array,r=Uint16Array,i=Int32Array,e=new n([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0,0,0,0]),o=new n([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,0,0]),s=new n([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),a=function(t,n){for(var e=new r(31),o=0;o<31;++o)e[o]=n+=1<<t[o-1];var s=new i(e[30]);for(o=1;o<30;++o)for(var a=e[o];a<e[o+1];++a)s[a]=a-e[o]<<5|o;return{b:e,r:s}},u=a(e,2),h=u.b,f=u.r;h[28]=258,f[258]=28;for(var c=a(o,0),l=c.b,p=c.r,v=new r(32768),d=0;d<32768;++d){var g=(43690&d)>>1|(21845&d)<<1;v[d]=((65280&(g=(61680&(g=(52428&g)>>2|(13107&g)<<2))>>4|(3855&g)<<4))>>8|(255&g)<<8)>>1}var y=function(t,n,i){for(var e=t.length,o=0,s=new r(n);o<e;++o)t[o]&&++s[t[o]-1];var a,u=new r(n);for(o=1;o<n;++o)u[o]=u[o-1]+s[o-1]<<1;if(i){a=new r(1<<n);var h=15-n;for(o=0;o<e;++o)if(t[o])for(var f=o<<4|t[o],c=n-t[o],l=u[t[o]-1]++<<c,p=l|(1<<c)-1;l<=p;++l)a[v[l]>>h]=f}else for(a=new r(e),o=0;o<e;++o)t[o]&&(a[o]=v[u[t[o]-1]++]>>15-t[o]);return a},m=new n(288);for(d=0;d<144;++d)m[d]=8;for(d=144;d<256;++d)m[d]=9;for(d=256;d<280;++d)m[d]=7;for(d=280;d<288;++d)m[d]=8;var b=new n(32);for(d=0;d<32;++d)b[d]=5;var w=y(m,9,0),x=y(m,9,1),z=y(b,5,0),k=y(b,5,1),M=function(t){for(var n=t[0],r=1;r<t.length;++r)t[r]>n&&(n=t[r]);return n},S=function(t,n,r){var i=n/8|0;return(t[i]|t[i+1]<<8)>>(7&n)&r},A=function(t,n){var r=n/8|0;return(t[r]|t[r+1]<<8|t[r+2]<<16)>>(7&n)},T=function(t){return(t+7)/8|0},D=function(t,r,i){return(null==r||r<0)&&(r=0),(null==i||i>t.length)&&(i=t.length),new n(t.subarray(r,i))};_e.FlateErrorCode={UnexpectedEOF:0,InvalidBlockType:1,InvalidLengthLiteral:2,InvalidDistance:3,StreamFinished:4,NoStreamHandler:5,InvalidHeader:6,NoCallback:7,InvalidUTF8:8,ExtraFieldTooLong:9,InvalidDate:10,FilenameTooLong:11,StreamFinishing:12,InvalidZipData:13,UnknownCompressionMethod:14};var C=["unexpected EOF","invalid block type","invalid length/literal","invalid distance","stream finished","no stream handler",,"no callback","invalid UTF-8 data","extra field too long","date not in range 1980-2099","filename too long","stream finishing","invalid zip data"],I=function(t,n,r){var i=Error(n||C[t]);if(i.code=t,Error.captureStackTrace&&Error.captureStackTrace(i,I),!r)throw i;return i},U=function(t,r,i,a){var u=t.length,f=a?a.length:0;if(!u||r.f&&!r.l)return i||new n(0);var c=!i,p=c||2!=r.i,v=r.i;c&&(i=new n(3*u));var d=function(t){var r=i.length;if(t>r){var e=new n(Math.max(2*r,t));e.set(i),i=e}},g=r.f||0,m=r.p||0,b=r.b||0,w=r.l,z=r.d,C=r.m,U=r.n,F=8*u;do{if(!w){g=S(t,m,1);var E=S(t,m+1,3);if(m+=3,!E){var Z=t[(Y=T(m)+4)-4]|t[Y-3]<<8,q=Y+Z;if(q>u){v&&I(0);break}p&&d(b+Z),i.set(t.subarray(Y,q),b),r.b=b+=Z,r.p=m=8*q,r.f=g;continue}if(1==E)w=x,z=k,C=9,U=5;else if(2==E){var O=S(t,m,31)+257,G=S(t,m+10,15)+4,L=O+S(t,m+5,31)+1;m+=14;for(var B=new n(L),H=new n(19),j=0;j<G;++j)H[s[j]]=S(t,m+3*j,7);m+=3*G;var N=M(H),P=(1<<N)-1,V=y(H,N,1);for(j=0;j<L;){var Y,J=V[S(t,m,P)];if(m+=15&J,(Y=J>>4)<16)B[j++]=Y;else{var K=0,Q=0;for(16==Y?(Q=3+S(t,m,3),m+=2,K=B[j-1]):17==Y?(Q=3+S(t,m,7),m+=3):18==Y&&(Q=11+S(t,m,127),m+=7);Q--;)B[j++]=K}}var R=B.subarray(0,O),W=B.subarray(O);C=M(R),U=M(W),w=y(R,C,1),z=y(W,U,1)}else I(1);if(m>F){v&&I(0);break}}p&&d(b+131072);for(var X=(1<<C)-1,$=(1<<U)-1,_=m;;_=m){var tt=(K=w[A(t,m)&X])>>4;if((m+=15&K)>F){v&&I(0);break}if(K||I(2),tt<256)i[b++]=tt;else{if(256==tt){_=m,w=null;break}var nt=tt-254;tt>264&&(nt=S(t,m,(1<<(et=e[j=tt-257]))-1)+h[j],m+=et);var rt=z[A(t,m)&$],it=rt>>4;if(rt||I(3),m+=15&rt,W=l[it],it>3){var et=o[it];W+=A(t,m)&(1<<et)-1,m+=et}if(m>F){v&&I(0);break}p&&d(b+131072);var ot=b+nt;if(b<W){var st=f-W,at=Math.min(W,ot);for(st+b<0&&I(3);b<at;++b)i[b]=a[st+b]}for(;b<ot;++b)i[b]=i[b-W]}}r.l=w,r.p=_,r.b=b,r.f=g,w&&(g=1,r.m=C,r.d=z,r.n=U)}while(!g);return b!=i.length&&c?D(i,0,b):i.subarray(0,b)},F=function(t,n,r){var i=n/8|0;t[i]|=r<<=7&n,t[i+1]|=r>>8},E=function(t,n,r){var i=n/8|0;t[i]|=r<<=7&n,t[i+1]|=r>>8,t[i+2]|=r>>16},Z=function(t,i){for(var e=[],o=0;o<t.length;++o)t[o]&&e.push({s:o,f:t[o]});var s=e.length,a=e.slice();if(!s)return{t:j,l:0};if(1==s){var u=new n(e[0].s+1);return u[e[0].s]=1,{t:u,l:1}}e.sort(function(t,n){return t.f-n.f}),e.push({s:-1,f:25001});var h=e[0],f=e[1],c=0,l=1,p=2;for(e[0]={s:-1,f:h.f+f.f,l:h,r:f};l!=s-1;)h=e[e[c].f<e[p].f?c++:p++],f=e[c!=l&&e[c].f<e[p].f?c++:p++],e[l++]={s:-1,f:h.f+f.f,l:h,r:f};var v=a[0].s;for(o=1;o<s;++o)a[o].s>v&&(v=a[o].s);var d=new r(v+1),g=q(e[l-1],d,0);if(g>i){o=0;var y=0,m=g-i,b=1<<m;for(a.sort(function(t,n){return d[n.s]-d[t.s]||t.f-n.f});o<s;++o){var w=a[o].s;if(!(d[w]>i))break;y+=b-(1<<g-d[w]),d[w]=i}for(y>>=m;y>0;){var x=a[o].s;d[x]<i?y-=1<<i-d[x]++-1:++o}for(;o>=0&&y;--o){var z=a[o].s;d[z]==i&&(--d[z],++y)}g=i}return{t:new n(d),l:g}},q=function(t,n,r){return-1==t.s?Math.max(q(t.l,n,r+1),q(t.r,n,r+1)):n[t.s]=r},O=function(t){for(var n=t.length;n&&!t[--n];);for(var i=new r(++n),e=0,o=t[0],s=1,a=function(t){i[e++]=t},u=1;u<=n;++u)if(t[u]==o&&u!=n)++s;else{if(!o&&s>2){for(;s>138;s-=138)a(32754);s>2&&(a(s>10?s-11<<5|28690:s-3<<5|12305),s=0)}else if(s>3){for(a(o),--s;s>6;s-=6)a(8304);s>2&&(a(s-3<<5|8208),s=0)}for(;s--;)a(o);s=1,o=t[u]}return{c:i.subarray(0,e),n:n}},G=function(t,n){for(var r=0,i=0;i<n.length;++i)r+=t[i]*n[i];return r},L=function(t,n,r){var i=r.length,e=T(n+2);t[e]=255&i,t[e+1]=i>>8,t[e+2]=255^t[e],t[e+3]=255^t[e+1];for(var o=0;o<i;++o)t[e+o+4]=r[o];return 8*(e+4+i)},B=function(t,n,i,a,u,h,f,c,l,p,v){F(n,v++,i),++u[256];for(var d=Z(u,15),g=d.t,x=d.l,k=Z(h,15),M=k.t,S=k.l,A=O(g),T=A.c,D=A.n,C=O(M),I=C.c,U=C.n,q=new r(19),B=0;B<T.length;++B)++q[31&T[B]];for(B=0;B<I.length;++B)++q[31&I[B]];for(var H=Z(q,7),j=H.t,N=H.l,P=19;P>4&&!j[s[P-1]];--P);var V,Y,J,K,Q=p+5<<3,R=G(u,m)+G(h,b)+f,W=G(u,g)+G(h,M)+f+14+3*P+G(q,j)+2*q[16]+3*q[17]+7*q[18];if(l>=0&&Q<=R&&Q<=W)return L(n,v,t.subarray(l,l+p));if(F(n,v,1+(W<R)),v+=2,W<R){V=y(g,x,0),Y=g,J=y(M,S,0),K=M;var X=y(j,N,0);for(F(n,v,D-257),F(n,v+5,U-1),F(n,v+10,P-4),v+=14,B=0;B<P;++B)F(n,v+3*B,j[s[B]]);v+=3*P;for(var $=[T,I],_=0;_<2;++_){var tt=$[_];for(B=0;B<tt.length;++B)F(n,v,X[rt=31&tt[B]]),v+=j[rt],rt>15&&(F(n,v,tt[B]>>5&127),v+=tt[B]>>12)}}else V=w,Y=m,J=z,K=b;for(B=0;B<c;++B){var nt=a[B];if(nt>255){var rt;E(n,v,V[257+(rt=nt>>18&31)]),v+=Y[rt+257],rt>7&&(F(n,v,nt>>23&31),v+=e[rt]);var it=31&nt;E(n,v,J[it]),v+=K[it],it>3&&(E(n,v,nt>>5&8191),v+=o[it])}else E(n,v,V[nt]),v+=Y[nt]}return E(n,v,V[256]),v+Y[256]},H=new i([65540,131080,131088,131104,262176,1048704,1048832,2114560,2117632]),j=new n(0),N=function(t,s,a,u,h,c){var l=c.z||t.length,v=new n(u+l+5*(1+Math.ceil(l/7e3))+h),d=v.subarray(u,v.length-h),g=c.l,y=7&(c.r||0);if(s){y&&(d[0]=c.r>>3);for(var m=H[s-1],b=m>>13,w=8191&m,x=(1<<a)-1,z=c.p||new r(32768),k=c.h||new r(x+1),M=Math.ceil(a/3),S=2*M,A=function(n){return(t[n]^t[n+1]<<M^t[n+2]<<S)&x},C=new i(25e3),I=new r(288),U=new r(32),F=0,E=0,Z=c.i||0,q=0,O=c.w||0,G=0;Z+2<l;++Z){var j=A(Z),N=32767&Z,P=k[j];if(z[N]=P,k[j]=N,O<=Z){var V=l-Z;if((F>7e3||q>24576)&&(V>423||!g)){y=B(t,d,0,C,I,U,E,q,G,Z-G,y),q=F=E=0,G=Z;for(var Y=0;Y<286;++Y)I[Y]=0;for(Y=0;Y<30;++Y)U[Y]=0}var J=2,K=0,Q=w,R=N-P&32767;if(V>2&&j==A(Z-R))for(var W=Math.min(b,V)-1,X=Math.min(32767,Z),$=Math.min(258,V);R<=X&&--Q&&N!=P;){if(t[Z+J]==t[Z+J-R]){for(var _=0;_<$&&t[Z+_]==t[Z+_-R];++_);if(_>J){if(J=_,K=R,_>W)break;var tt=Math.min(R,_-2),nt=0;for(Y=0;Y<tt;++Y){var rt=Z-R+Y&32767,it=rt-z[rt]&32767;it>nt&&(nt=it,P=rt)}}}R+=(N=P)-(P=z[N])&32767}if(K){C[q++]=268435456|f[J]<<18|p[K];var et=31&f[J],ot=31&p[K];E+=e[et]+o[ot],++I[257+et],++U[ot],O=Z+J,++F}else C[q++]=t[Z],++I[t[Z]]}}for(Z=Math.max(Z,O);Z<l;++Z)C[q++]=t[Z],++I[t[Z]];y=B(t,d,g,C,I,U,E,q,G,Z-G,y),g||(c.r=7&y|d[y/8|0]<<3,y-=7,c.h=k,c.p=z,c.i=Z,c.w=O)}else{for(Z=c.w||0;Z<l+g;Z+=65535){var st=Z+65535;st>=l&&(d[y/8|0]=g,st=l),y=L(d,y+1,t.subarray(Z,st))}c.i=l}return D(v,0,u+T(y)+h)},P=function(){for(var t=new Int32Array(256),n=0;n<256;++n){for(var r=n,i=9;--i;)r=(1&r&&-306674912)^r>>>1;t[n]=r}return t}(),V=function(){var t=-1;return{p:function(n){for(var r=t,i=0;i<n.length;++i)r=P[255&r^n[i]]^r>>>8;t=r},d:function(){return~t}}},Y=function(){var t=1,n=0;return{p:function(r){for(var i=t,e=n,o=0|r.length,s=0;s!=o;){for(var a=Math.min(s+2655,o);s<a;++s)e+=i+=r[s];i=(65535&i)+15*(i>>16),e=(65535&e)+15*(e>>16)}t=i,n=e},d:function(){return(255&(t%=65521))<<24|(65280&t)<<8|(255&(n%=65521))<<8|n>>8}}},J=function(t,r,i,e,o){if(!o&&(o={l:1},r.dictionary)){var s=r.dictionary.subarray(-32768),a=new n(s.length+t.length);a.set(s),a.set(t,s.length),t=a,o.w=s.length}return N(t,null==r.level?6:r.level,null==r.mem?o.l?Math.ceil(1.5*Math.max(8,Math.min(13,Math.log(t.length)))):20:12+r.mem,i,e,o)},K=function(t,n){var r={};for(var i in t)r[i]=t[i];for(var i in n)r[i]=n[i];return r},Q=function(t,n,r){for(var i=t(),e=""+t,o=e.slice(e.indexOf("[")+1,e.lastIndexOf("]")).replace(/\s+/g,"").split(","),s=0;s<i.length;++s){var a=i[s],u=o[s];if("function"==typeof a){n+=";"+u+"=";var h=""+a;if(a.prototype)if(-1!=h.indexOf("[native code]")){var f=h.indexOf(" ",8)+1;n+=h.slice(f,h.indexOf("(",f))}else for(var c in n+=h,a.prototype)n+=";"+u+".prototype."+c+"="+a.prototype[c];else n+=h}else r[u]=a}return n},R=[],W=function(t){var n=[];for(var r in t)t[r].buffer&&n.push((t[r]=new t[r].constructor(t[r])).buffer);return n},X=function(n,r,i,e){if(!R[i]){for(var o="",s={},a=n.length-1,u=0;u<a;++u)o=Q(n[u],o,s);R[i]={c:Q(n[a],o,s),e:s}}var h=K({},R[i].e);return(0,t.default)(R[i].c+";onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage="+r+"}",i,h,W(h),e)},$=function(){return[n,r,i,e,o,s,h,l,x,k,v,C,y,M,S,A,T,D,I,U,Tt,et,ot]},_=function(){return[n,r,i,e,o,s,f,p,w,m,z,b,v,H,j,y,F,E,Z,q,O,G,L,B,T,D,N,J,kt,et]},tt=function(){return[pt,gt,lt,V,P]},nt=function(){return[vt,dt]},rt=function(){return[yt,lt,Y]},it=function(){return[mt]},et=function(t){return postMessage(t,[t.buffer])},ot=function(t){return t&&{out:t.size&&new n(t.size),dictionary:t.dictionary}},st=function(t,n,r,i,e,o){var s=X(r,i,e,function(t,n){s.terminate(),o(t,n)});return s.postMessage([t,n],n.consume?[t.buffer]:[]),function(){s.terminate()}},at=function(t){return t.ondata=function(t,n){return postMessage([t,n],[t.buffer])},function(n){n.data[0]?(t.push(n.data[0],n.data[1]),postMessage([n.data[0].length])):t.flush(n.data[1])}},ut=function(t,n,r,i,e,o,s){var a,u=X(t,i,e,function(t,r){t?(u.terminate(),n.ondata.call(n,t)):Array.isArray(r)?1==r.length?(n.queuedSize-=r[0],n.ondrain&&n.ondrain(r[0])):(r[1]&&u.terminate(),n.ondata.call(n,t,r[0],r[1])):s(r)});u.postMessage(r),n.queuedSize=0,n.push=function(t,r){n.ondata||I(5),a&&n.ondata(I(4,0,1),null,!!r),n.queuedSize+=t.length,u.postMessage([t,a=r],t.buffer instanceof ArrayBuffer?[t.buffer]:[])},n.terminate=function(){u.terminate()},o&&(n.flush=function(t){u.postMessage([0,t])})},ht=function(t,n){return t[n]|t[n+1]<<8},ft=function(t,n){return(t[n]|t[n+1]<<8|t[n+2]<<16|t[n+3]<<24)>>>0},ct=function(t,n){return ft(t,n)+4294967296*ft(t,n+4)},lt=function(t,n,r){for(;r;++n)t[n]=r,r>>>=8},pt=function(t,n){var r=n.filename;if(t[0]=31,t[1]=139,t[2]=8,t[8]=n.level<2?4:9==n.level?2:0,t[9]=3,0!=n.mtime&&lt(t,4,Math.floor(new Date(n.mtime||Date.now())/1e3)),r){t[3]=8;for(var i=0;i<=r.length;++i)t[i+10]=r.charCodeAt(i)}},vt=function(t){31==t[0]&&139==t[1]&&8==t[2]||I(6,"invalid gzip data");var n=t[3],r=10;4&n&&(r+=2+(t[10]|t[11]<<8));for(var i=(n>>3&1)+(n>>4&1);i>0;i-=!t[r++]);return r+(2&n)},dt=function(t){var n=t.length;return(t[n-4]|t[n-3]<<8|t[n-2]<<16|t[n-1]<<24)>>>0},gt=function(t){return 10+(t.filename?t.filename.length+1:0)},yt=function(t,n){var r=n.level,i=0==r?0:r<6?1:9==r?3:2;if(t[0]=120,t[1]=i<<6|(n.dictionary&&32),t[1]|=31-(t[0]<<8|t[1])%31,n.dictionary){var e=Y();e.p(n.dictionary),lt(t,2,e.d())}},mt=function(t,n){return(8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31)&&I(6,"invalid zlib data"),(t[1]>>5&1)==+!n&&I(6,"invalid zlib data: "+(32&t[1]?"need":"unexpected")+" dictionary"),2+(t[1]>>3&4)};function bt(t,n){return"function"==typeof t&&(n=t,t={}),this.ondata=n,t}var wt=function(){function t(t,r){if("function"==typeof t&&(r=t,t={}),this.ondata=r,this.o=t||{},this.s={l:0,i:32768,w:32768,z:32768},this.b=new n(98304),this.o.dictionary){var i=this.o.dictionary.subarray(-32768);this.b.set(i,32768-i.length),this.s.i=32768-i.length}}return t.prototype.p=function(t,n){this.ondata(J(t,this.o,0,0,this.s),n)},t.prototype.push=function(t,r){this.ondata||I(5),this.s.l&&I(4);var i=t.length+this.s.z;if(i>this.b.length){if(i>2*this.b.length-32768){var e=new n(-32768&i);e.set(this.b.subarray(0,this.s.z)),this.b=e}var o=this.b.length-this.s.z;this.b.set(t.subarray(0,o),this.s.z),this.s.z=this.b.length,this.p(this.b,!1),this.b.set(this.b.subarray(-32768)),this.b.set(t.subarray(o),32768),this.s.z=t.length-o+32768,this.s.i=32766,this.s.w=32768}else this.b.set(t,this.s.z),this.s.z+=t.length;this.s.l=1&r,(this.s.z>this.s.w+8191||r)&&(this.p(this.b,r||!1),this.s.w=this.s.i,this.s.i-=2),r&&(this.s=this.o={},this.b=j)},t.prototype.flush=function(t){if(this.ondata||I(5),this.s.l&&I(4),this.p(this.b,!1),this.s.w=this.s.i,this.s.i-=2,t){var r=new n(6);r[0]=this.s.r>>3;var i=L(r,this.s.r,j);this.s.r=0,this.ondata(r.subarray(0,i>>3),!1)}},t}();_e.Deflate=wt;var xt=function(){return function(t,n){ut([_,function(){return[at,wt]}],this,bt.call(this,t,n),function(t){var n=new wt(t.data);onmessage=at(n)},6,1)}}();function zt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[_],function(t){return et(kt(t.data[0],t.data[1]))},0,r)}function kt(t,n){return J(t,n||{},0,0)}_e.AsyncDeflate=xt;var Mt=function(){function t(t,r){"function"==typeof t&&(r=t,t={}),this.ondata=r;var i=t&&t.dictionary&&t.dictionary.subarray(-32768);this.s={i:0,b:i?i.length:0},this.o=new n(32768),this.p=new n(0),i&&this.o.set(i)}return t.prototype.e=function(t){if(this.ondata||I(5),this.d&&I(4),this.p.length){if(t.length){var r=new n(this.p.length+t.length);r.set(this.p),r.set(t,this.p.length),this.p=r}}else this.p=t},t.prototype.c=function(t){this.s.i=+(this.d=t||!1);var n=this.s.b,r=U(this.p,this.s,this.o);this.ondata(D(r,n,this.s.b),this.d),this.o=D(r,this.s.b-32768),this.s.b=this.o.length,this.p=D(this.p,this.s.p/8|0),this.s.p&=7},t.prototype.push=function(t,n){this.e(t),this.c(n)},t}();_e.Inflate=Mt;var St=function(){return function(t,n){ut([$,function(){return[at,Mt]}],this,bt.call(this,t,n),function(t){var n=new Mt(t.data);onmessage=at(n)},7,0)}}();function At(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[$],function(t){return et(Tt(t.data[0],ot(t.data[1])))},1,r)}function Tt(t,n){return U(t,{i:2},n&&n.out,n&&n.dictionary)}_e.AsyncInflate=St;var Dt=function(){function t(t,n){this.c=V(),this.l=0,this.v=1,wt.call(this,t,n)}return t.prototype.push=function(t,n){this.c.p(t),this.l+=t.length,wt.prototype.push.call(this,t,n)},t.prototype.p=function(t,n){var r=J(t,this.o,this.v&&gt(this.o),n&&8,this.s);this.v&&(pt(r,this.o),this.v=0),n&&(lt(r,r.length-8,this.c.d()),lt(r,r.length-4,this.l)),this.ondata(r,n)},t.prototype.flush=function(t){wt.prototype.flush.call(this,t)},t}();_e.Gzip=Dt,_e.Compress=Dt;var Ct=function(){return function(t,n){ut([_,tt,function(){return[at,wt,Dt]}],this,bt.call(this,t,n),function(t){var n=new Dt(t.data);onmessage=at(n)},8,1)}}();function It(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[_,tt,function(){return[Ut]}],function(t){return et(Ut(t.data[0],t.data[1]))},2,r)}function Ut(t,n){n||(n={});var r=V(),i=t.length;r.p(t);var e=J(t,n,gt(n),8),o=e.length;return pt(e,n),lt(e,o-8,r.d()),lt(e,o-4,i),e}_e.AsyncGzip=Ct,_e.AsyncCompress=Ct;var Ft=function(){function t(t,n){this.v=1,this.r=0,Mt.call(this,t,n)}return t.prototype.push=function(t,r){if(Mt.prototype.e.call(this,t),this.r+=t.length,this.v){var i=this.p.subarray(this.v-1),e=i.length>3?vt(i):4;if(e>i.length){if(!r)return}else this.v>1&&this.onmember&&this.onmember(this.r-i.length);this.p=i.subarray(e),this.v=0}Mt.prototype.c.call(this,0),this.s.f&&!this.s.l?(this.v=T(this.s.p)+9,this.s={i:0},this.o=new n(0),this.push(new n(0),r)):r&&Mt.prototype.c.call(this,r)},t}();_e.Gunzip=Ft;var Et=function(){return function(t,n){var r=this;ut([$,nt,function(){return[at,Mt,Ft]}],this,bt.call(this,t,n),function(t){var n=new Ft(t.data);n.onmember=function(t){return postMessage(t)},onmessage=at(n)},9,0,function(t){return r.onmember&&r.onmember(t)})}}();function Zt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[$,nt,function(){return[qt]}],function(t){return et(qt(t.data[0],t.data[1]))},3,r)}function qt(t,r){var i=vt(t);return i+8>t.length&&I(6,"invalid gzip data"),U(t.subarray(i,-8),{i:2},r&&r.out||new n(dt(t)),r&&r.dictionary)}_e.AsyncGunzip=Et;var Ot=function(){function t(t,n){this.c=Y(),this.v=1,wt.call(this,t,n)}return t.prototype.push=function(t,n){this.c.p(t),wt.prototype.push.call(this,t,n)},t.prototype.p=function(t,n){var r=J(t,this.o,this.v&&(this.o.dictionary?6:2),n&&4,this.s);this.v&&(yt(r,this.o),this.v=0),n&&lt(r,r.length-4,this.c.d()),this.ondata(r,n)},t.prototype.flush=function(t){wt.prototype.flush.call(this,t)},t}();_e.Zlib=Ot;var Gt=function(){return function(t,n){ut([_,rt,function(){return[at,wt,Ot]}],this,bt.call(this,t,n),function(t){var n=new Ot(t.data);onmessage=at(n)},10,1)}}();function Lt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[_,rt,function(){return[Bt]}],function(t){return et(Bt(t.data[0],t.data[1]))},4,r)}function Bt(t,n){n||(n={});var r=Y();r.p(t);var i=J(t,n,n.dictionary?6:2,4);return yt(i,n),lt(i,i.length-4,r.d()),i}_e.AsyncZlib=Gt;var Ht=function(){function t(t,n){Mt.call(this,t,n),this.v=t&&t.dictionary?2:1}return t.prototype.push=function(t,n){if(Mt.prototype.e.call(this,t),this.v){if(this.p.length<6&&!n)return;this.p=this.p.subarray(mt(this.p,this.v-1)),this.v=0}n&&(this.p.length<4&&I(6,"invalid zlib data"),this.p=this.p.subarray(0,-4)),Mt.prototype.c.call(this,n)},t}();_e.Unzlib=Ht;var jt=function(){return function(t,n){ut([$,it,function(){return[at,Mt,Ht]}],this,bt.call(this,t,n),function(t){var n=new Ht(t.data);onmessage=at(n)},11,0)}}();function Nt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),st(t,n,[$,it,function(){return[Pt]}],function(t){return et(Pt(t.data[0],ot(t.data[1])))},5,r)}function Pt(t,n){return U(t.subarray(mt(t,n&&n.dictionary),-4),{i:2},n&&n.out,n&&n.dictionary)}_e.AsyncUnzlib=jt;var Vt=function(){function t(t,n){this.o=bt.call(this,t,n)||{},this.G=Ft,this.I=Mt,this.Z=Ht}return t.prototype.i=function(){var t=this;this.s.ondata=function(n,r){t.ondata(n,r)}},t.prototype.push=function(t,r){if(this.ondata||I(5),this.s)this.s.push(t,r);else{if(this.p&&this.p.length){var i=new n(this.p.length+t.length);i.set(this.p),i.set(t,this.p.length)}else this.p=t;this.p.length>2&&(this.s=31==this.p[0]&&139==this.p[1]&&8==this.p[2]?new this.G(this.o):8!=(15&this.p[0])||this.p[0]>>4>7||(this.p[0]<<8|this.p[1])%31?new this.I(this.o):new this.Z(this.o),this.i(),this.s.push(this.p,r),this.p=null)}},t}();_e.Decompress=Vt;var Yt=function(){function t(t,n){Vt.call(this,t,n),this.queuedSize=0,this.G=Et,this.I=St,this.Z=jt}return t.prototype.i=function(){var t=this;this.s.ondata=function(n,r,i){t.ondata(n,r,i)},this.s.ondrain=function(n){t.queuedSize-=n,t.ondrain&&t.ondrain(n)}},t.prototype.push=function(t,n){this.queuedSize+=t.length,Vt.prototype.push.call(this,t,n)},t}();function Jt(t,n,r){return r||(r=n,n={}),"function"!=typeof r&&I(7),31==t[0]&&139==t[1]&&8==t[2]?Zt(t,n,r):8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31?At(t,n,r):Nt(t,n,r)}function Kt(t,n){return 31==t[0]&&139==t[1]&&8==t[2]?qt(t,n):8!=(15&t[0])||t[0]>>4>7||(t[0]<<8|t[1])%31?Tt(t,n):Pt(t,n)}_e.AsyncDecompress=Yt;var Qt=function(t,r,i,e){for(var o in t){var s=t[o],a=r+o,u=e;Array.isArray(s)&&(u=K(e,s[1]),s=s[0]),ArrayBuffer.isView(s)?i[a]=[s,u]:(i[a+="/"]=[new n(0),u],Qt(s,a,i,e))}},Rt="undefined"!=typeof TextEncoder&&new TextEncoder,Wt="undefined"!=typeof TextDecoder&&new TextDecoder,Xt=0;try{Wt.decode(j,{stream:!0}),Xt=1}catch(t){}var $t=function(t){for(var n="",r=0;;){var i=t[r++],e=(i>127)+(i>223)+(i>239);if(r+e>t.length)return{s:n,r:D(t,r-1)};e?3==e?(i=((15&i)<<18|(63&t[r++])<<12|(63&t[r++])<<6|63&t[r++])-65536,n+=String.fromCharCode(55296|i>>10,56320|1023&i)):n+=String.fromCharCode(1&e?(31&i)<<6|63&t[r++]:(15&i)<<12|(63&t[r++])<<6|63&t[r++]):n+=String.fromCharCode(i)}},_t=function(){function t(t){this.ondata=t,Xt?this.t=new TextDecoder:this.p=j}return t.prototype.push=function(t,r){if(this.ondata||I(5),r=!!r,this.t)return this.ondata(this.t.decode(t,{stream:!0}),r),void(r&&(this.t.decode().length&&I(8),this.t=null));this.p||I(4);var i=new n(this.p.length+t.length);i.set(this.p),i.set(t,this.p.length);var e=$t(i),o=e.s,s=e.r;r?(s.length&&I(8),this.p=null):this.p=s,this.ondata(o,r)},t}();_e.DecodeUTF8=_t;var tn=function(){function t(t){this.ondata=t}return t.prototype.push=function(t,n){this.ondata||I(5),this.d&&I(4),this.ondata(nn(t),this.d=n||!1)},t}();function nn(t,r){if(r){for(var i=new n(t.length),e=0;e<t.length;++e)i[e]=t.charCodeAt(e);return i}if(Rt)return Rt.encode(t);var o=t.length,s=new n(t.length+(t.length>>1)),a=0,u=function(t){s[a++]=t};for(e=0;e<o;++e){if(a+5>s.length){var h=new n(a+8+(o-e<<1));h.set(s),s=h}var f=t.charCodeAt(e);f<128||r?u(f):f<2048?(u(192|f>>6),u(128|63&f)):f>55295&&f<57344?(u(240|(f=65536+(1047552&f)|1023&t.charCodeAt(++e))>>18),u(128|f>>12&63),u(128|f>>6&63),u(128|63&f)):(u(224|f>>12),u(128|f>>6&63),u(128|63&f))}return D(s,0,a)}function rn(t,n){if(n){for(var r="",i=0;i<t.length;i+=16384)r+=String.fromCharCode.apply(null,t.subarray(i,i+16384));return r}if(Wt)return Wt.decode(t);var e=$t(t),o=e.s;return(r=e.r).length&&I(8),o}_e.EncodeUTF8=tn;var en=function(t){return 1==t?3:t<6?2:9==t?1:0},on=function(t,n){return n+30+ht(t,n+26)+ht(t,n+28)},sn=function(t,n,r){var i=ht(t,n+28),e=ht(t,n+30),o=rn(t.subarray(n+46,n+46+i),!(2048&ht(t,n+8))),s=n+46+i,a=an(t,s,e,r,ft(t,n+20),ft(t,n+24),ft(t,n+42)),u=a[0],h=a[1],f=a[2];return[ht(t,n+10),u,h,o,s+e+ht(t,n+32),f]},an=function(t,n,r,i,e,o,s){var a=4294967295==e,u=4294967295==o,h=4294967295==s,f=n+r;if(i&&a+u+h){for(;n+4<f;n+=4+ht(t,n+2))if(1==ht(t,n))return[a?ct(t,n+4+8*u):e,u?ct(t,n+4):o,h?ct(t,n+4+8*(u+a)):s,1];i<2&&I(13)}return[e,o,s,0]},un=function(t){var n=0;if(t)for(var r in t){var i=t[r].length;i>65535&&I(9),n+=i+4}return n},hn=function(t,n,r,i,e,o,s,a){var u=i.length,h=r.extra,f=a&&a.length,c=un(h);lt(t,n,null!=s?33639248:67324752),n+=4,null!=s&&(t[n++]=20,t[n++]=r.os),t[n]=20,n+=2,t[n++]=r.flag<<1|(o<0&&8),t[n++]=e&&8,t[n++]=255&r.compression,t[n++]=r.compression>>8;var l=new Date(null==r.mtime?Date.now():r.mtime),p=l.getFullYear()-1980;if((p<0||p>119)&&I(10),lt(t,n,p<<25|l.getMonth()+1<<21|l.getDate()<<16|l.getHours()<<11|l.getMinutes()<<5|l.getSeconds()>>1),n+=4,-1!=o&&(lt(t,n,r.crc),lt(t,n+4,o<0?-o-2:o),lt(t,n+8,r.size)),lt(t,n+12,u),lt(t,n+14,c),n+=16,null!=s&&(lt(t,n,f),lt(t,n+6,r.attrs),lt(t,n+10,s),n+=14),t.set(i,n),n+=u,c)for(var v in h){var d=h[v],g=d.length;lt(t,n,+v),lt(t,n+2,g),t.set(d,n+4),n+=4+g}return f&&(t.set(a,n),n+=f),n},fn=function(t,n,r,i,e){lt(t,n,101010256),lt(t,n+8,r),lt(t,n+10,r),lt(t,n+12,i),lt(t,n+16,e)},cn=function(){function t(t){this.filename=t,this.c=V(),this.size=0,this.compression=0}return t.prototype.process=function(t,n){this.ondata(null,t,n)},t.prototype.push=function(t,n){this.ondata||I(5),this.c.p(t),this.size+=t.length,n&&(this.crc=this.c.d()),this.process(t,n||!1)},t}();_e.ZipPassThrough=cn;var ln=function(){function t(t,n){var r=this;n||(n={}),cn.call(this,t),this.d=new wt(n,function(t,n){r.ondata(null,t,n)}),this.compression=8,this.flag=en(n.level)}return t.prototype.process=function(t,n){try{this.d.push(t,n)}catch(t){this.ondata(t,null,n)}},t.prototype.push=function(t,n){cn.prototype.push.call(this,t,n)},t}();_e.ZipDeflate=ln;var pn=function(){function t(t,n){var r=this;n||(n={}),cn.call(this,t),this.d=new xt(n,function(t,n,i){r.ondata(t,n,i)}),this.compression=8,this.flag=en(n.level),this.terminate=this.d.terminate}return t.prototype.process=function(t,n){this.d.push(t,n)},t.prototype.push=function(t,n){cn.prototype.push.call(this,t,n)},t}();_e.AsyncZipDeflate=pn;var vn=function(){function t(t){this.ondata=t,this.u=[],this.d=1}return t.prototype.add=function(t){var r=this;if(this.ondata||I(5),2&this.d)this.ondata(I(4+8*(1&this.d),0,1),null,!1);else{var i=nn(t.filename),e=i.length,o=t.comment,s=o&&nn(o),a=e!=t.filename.length||s&&o.length!=s.length,u=e+un(t.extra)+30;e>65535&&this.ondata(I(11,0,1),null,!1);var h=new n(u);hn(h,0,t,i,a,-1);var f=[h],c=function(){for(var t=0,n=f;t<n.length;t++)r.ondata(null,n[t],!1);f=[]},l=this.d;this.d=0;var p=this.u.length,v=K(t,{f:i,u:a,o:s,t:function(){t.terminate&&t.terminate()},r:function(){if(c(),l){var t=r.u[p+1];t?t.r():r.d=1}l=1}}),d=0;t.ondata=function(i,e,o){if(i)r.ondata(i,e,o),r.terminate();else if(d+=e.length,f.push(e),o){var s=new n(16);lt(s,0,134695760),lt(s,4,t.crc),lt(s,8,d),lt(s,12,t.size),f.push(s),v.c=d,v.b=u+d+16,v.crc=t.crc,v.size=t.size,l&&v.r(),l=1}else l&&c()},this.u.push(v)}},t.prototype.end=function(){var t=this;2&this.d?this.ondata(I(4+8*(1&this.d),0,1),null,!0):(this.d?this.e():this.u.push({r:function(){1&t.d&&(t.u.splice(-1,1),t.e())},t:function(){}}),this.d=3)},t.prototype.e=function(){for(var t=0,r=0,i=0,e=0,o=this.u;e<o.length;e++)i+=46+(h=o[e]).f.length+un(h.extra)+(h.o?h.o.length:0);for(var s=new n(i+22),a=0,u=this.u;a<u.length;a++){var h;hn(s,t,h=u[a],h.f,h.u,-h.c-2,r,h.o),t+=46+h.f.length+un(h.extra)+(h.o?h.o.length:0),r+=h.b}fn(s,t,this.u.length,i,r),this.ondata(null,s,!0),this.d=2},t.prototype.terminate=function(){for(var t=0,n=this.u;t<n.length;t++)n[t].t();this.d=2},t}();function dn(t,r,i){i||(i=r,r={}),"function"!=typeof i&&I(7);var e={};Qt(t,"",e,r);var o=Object.keys(e),s=o.length,a=0,u=0,h=s,f=Array(s),c=[],l=function(){for(var t=0;t<c.length;++t)c[t]()},p=function(t,n){xn(function(){i(t,n)})};xn(function(){p=i});var v=function(){var t=new n(u+22),r=a,i=u-a;u=0;for(var e=0;e<h;++e){var o=f[e];try{var s=o.c.length;hn(t,u,o,o.f,o.u,s);var c=30+o.f.length+un(o.extra),l=u+c;t.set(o.c,l),hn(t,a,o,o.f,o.u,s,u,o.m),a+=16+c+(o.m?o.m.length:0),u=l+s}catch(t){return p(t,null)}}fn(t,a,f.length,i,r),p(null,t)};s||v();for(var d=function(t){var n=o[t],r=e[n],i=r[0],h=r[1],d=V(),g=i.length;d.p(i);var y=nn(n),m=y.length,b=h.comment,w=b&&nn(b),x=w&&w.length,z=un(h.extra),k=0==h.level?0:8,M=function(r,i){if(r)l(),p(r,null);else{var e=i.length;f[t]=K(h,{size:g,crc:d.d(),c:i,f:y,m:w,u:m!=n.length||w&&b.length!=x,compression:k}),a+=30+m+z+e,u+=76+2*(m+z)+(x||0)+e,--s||v()}};if(m>65535&&M(I(11,0,1),null),k)if(g<16e4)try{M(null,kt(i,h))}catch(t){M(t,null)}else c.push(zt(i,h,M));else M(null,i)},g=0;g<h;++g)d(g);return l}function gn(t,r){r||(r={});var i={},e=[];Qt(t,"",i,r);var o=0,s=0;for(var a in i){var u=i[a],h=u[0],f=u[1],c=0==f.level?0:8,l=(M=nn(a)).length,p=f.comment,v=p&&nn(p),d=v&&v.length,g=un(f.extra);l>65535&&I(11);var y=c?kt(h,f):h,m=y.length,b=V();b.p(h),e.push(K(f,{size:h.length,crc:b.d(),c:y,f:M,m:v,u:l!=a.length||v&&p.length!=d,o:o,compression:c})),o+=30+l+g+m,s+=76+2*(l+g)+(d||0)+m}for(var w=new n(s+22),x=o,z=s-o,k=0;k<e.length;++k){var M;hn(w,(M=e[k]).o,M,M.f,M.u,M.c.length);var S=30+M.f.length+un(M.extra);w.set(M.c,M.o+S),hn(w,o,M,M.f,M.u,M.c.length,M.o,M.m),o+=16+S+(M.m?M.m.length:0)}return fn(w,o,e.length,z,x),w}_e.Zip=vn;var yn=function(){function t(){}return t.prototype.push=function(t,n){this.ondata(null,t,n)},t.compression=0,t}();_e.UnzipPassThrough=yn;var mn=function(){function t(){var t=this;this.i=new Mt(function(n,r){t.ondata(null,n,r)})}return t.prototype.push=function(t,n){try{this.i.push(t,n)}catch(t){this.ondata(t,null,n)}},t.compression=8,t}();_e.UnzipInflate=mn;var bn=function(){function t(t,n){var r=this;n<32e4?this.i=new Mt(function(t,n){r.ondata(null,t,n)}):(this.i=new St(function(t,n,i){r.ondata(t,n,i)}),this.terminate=this.i.terminate)}return t.prototype.push=function(t,n){this.i.terminate&&(t=D(t,0)),this.i.push(t,n)},t.compression=8,t}();_e.AsyncUnzipInflate=bn;var wn=function(){function t(t){this.onfile=t,this.k=[],this.o={0:yn},this.p=j}return t.prototype.push=function(t,r){var i=this;if(this.onfile||I(5),this.p||I(4),this.c>0){var e=Math.min(this.c,t.length),o=t.subarray(0,e);if(this.c-=e,this.d?this.d.push(o,!this.c):this.k[0].push(o),(t=t.subarray(e)).length)return this.push(t,r)}else{var s=0,a=0,u=void 0,h=void 0;this.p.length?t.length?((h=new n(this.p.length+t.length)).set(this.p),h.set(t,this.p.length)):h=this.p:h=t;for(var f=h.length,c=this.c,l=c&&this.d,p=function(){var t=ft(h,a);if(67324752==t){s=1,u=a,v.d=null,v.c=0;var n=ht(h,a+6),r=ht(h,a+8),e=2048&n,o=8&n,l=ht(h,a+26),p=ht(h,a+28);if(f>a+30+l+p){var d=[];v.k.unshift(d),s=2;var g,y=ft(h,a+18),m=ft(h,a+22),b=rn(h.subarray(a+30,a+=30+l),!e),w=an(h,a,p,2,y,m,0),x=w[0],z=w[1];o&&(x=-1-w[3]),a+=p,v.c=x;var k={name:b,compression:r,start:function(){if(k.ondata||I(5),x){var t=i.o[r];t||k.ondata(I(14,"unknown compression type "+r,1),null,!1),(g=x<0?new t(b):new t(b,x,z)).ondata=function(t,n,r){k.ondata(t,n,r)};for(var n=0,e=d;n<e.length;n++)g.push(e[n],!1);i.k[0]==d&&i.c?i.d=g:g.push(j,!0)}else k.ondata(null,j,!0)},terminate:function(){g&&g.terminate&&g.terminate()}};x>=0&&(k.size=x,k.originalSize=z),v.onfile(k)}return"break"}if(c){if(134695760==t)return u=a+=12+(-2==c&&8),s=3,v.c=0,"break";if(33639248==t)return u=a-=4,s=3,v.c=0,"break"}},v=this;a<f-4&&"break"!==p();++a);if(this.p=j,c<0){var d=h.subarray(0,s?u-12-(-2==c&&8)-(134695760==ft(h,u-16)&&4):a);l?l.push(d,!!s):this.k[+(2==s)].push(d)}if(2&s)return this.push(h.subarray(a),r);this.p=h.subarray(a)}r&&(this.c&&I(13),this.p=null)},t.prototype.register=function(t){this.o[t.compression]=t},t}();_e.Unzip=wn;var xn="function"==typeof queueMicrotask?queueMicrotask:"function"==typeof setTimeout?setTimeout:function(t){t()};function zn(t,r,i){i||(i=r,r={}),"function"!=typeof i&&I(7);var e=[],o=function(){for(var t=0;t<e.length;++t)e[t]()},s={},a=function(t,n){xn(function(){i(t,n)})};xn(function(){a=i});for(var u=t.length-22;101010256!=ft(t,u);--u)if(!u||t.length-u>65558)return a(I(13,0,1),null),o;var h=ht(t,u+8);if(h){var f=h,c=ft(t,u+16),l=117853008==ft(t,u-20);if(l){var p=ft(t,u-12);(l=101075792==ft(t,p))&&(f=h=ft(t,p+32),c=ft(t,p+48))}for(var v=r&&r.filter,d=function(r){var i=sn(t,c,l),u=i[0],f=i[1],p=i[2],d=i[3],g=i[4],y=on(t,i[5]);c=g;var m=function(t,n){t?(o(),a(t,null)):(n&&(s[d]=n),--h||a(null,s))};if(!v||v({name:d,size:f,originalSize:p,compression:u}))if(u)if(8==u){var b=t.subarray(y,y+f);if(p<524288||f>.8*p)try{m(null,Tt(b,{out:new n(p)}))}catch(t){m(t,null)}else e.push(At(b,{size:p},m))}else m(I(14,"unknown compression type "+u,1),null);else m(null,D(t,y,y+f));else m(null,null)},g=0;g<f;++g)d()}else a(null,{});return o}function kn(t,r){for(var i={},e=t.length-22;101010256!=ft(t,e);--e)(!e||t.length-e>65558)&&I(13);var o=ht(t,e+8);if(!o)return{};var s=ft(t,e+16),a=117853008==ft(t,e-20);if(a){var u=ft(t,e-12);(a=101075792==ft(t,u))&&(o=ft(t,u+32),s=ft(t,u+48))}for(var h=r&&r.filter,f=0;f<o;++f){var c=sn(t,s,a),l=c[0],p=c[1],v=c[2],d=c[3],g=c[4],y=on(t,c[5]);s=g,h&&!h({name:d,size:p,originalSize:v,compression:l})||(l?8==l?i[d]=Tt(t.subarray(y,y+p),{out:new n(v)}):I(14,"unknown compression type "+l):i[d]=D(t,y,y+p))}return i}return _e});
    }).call(null, moduleObject, moduleObject.exports);
    return moduleObject.exports;
  })();

  function installGui() {
    const mount = () => {
      if (!document.body || document.getElementById(GUI_ROOT_ID)) {
        return;
      }

      const style = document.createElement("style");
      style.id = `${GUI_ROOT_ID}-style`;
      style.textContent = `
        #${GUI_ROOT_ID}{
          --ace-font-sans: var(--font-basel-grotesk), var(--font-inter), ui-sans-serif, system-ui, sans-serif;
          --ace-surface: hsl(var(--surface-secondary, 0 0% 100%));
          --ace-surface-soft: hsl(var(--surface-tertiary, 33 31% 94%));
          --ace-surface-raised: hsl(var(--surface-raised, 33 28% 92%));
          --ace-surface-raised-alt: hsl(var(--surface-raised-alt, 33 20% 87%));
          --ace-surface-floating: hsl(var(--surface-floating, 33 60% 96%));
          --ace-text: hsl(var(--text-primary, 24 6% 17%));
          --ace-text-secondary: hsl(var(--text-secondary, 30 7% 24%));
          --ace-text-muted: hsl(var(--text-muted, 37 5% 52%));
          --ace-border: hsl(var(--border-medium, 30 9% 87%));
          --ace-border-faint: hsl(var(--border-faint, 30 5% 93%));
          --ace-primary: hsl(var(--interactive-cta, 60 3% 14%));
          --ace-primary-hover: hsl(var(--interactive-cta-hover, 24 6% 23%));
          --ace-primary-text: hsl(var(--interactive-on-cta, 36 45% 98%));
          --ace-link: hsl(var(--interactive-link, 208 77% 52%));
          --ace-positive: hsl(var(--interactive-positive, 125 49% 43%));
          --ace-negative: hsl(var(--interactive-negative, 2 63% 54%));
          --ace-radius: calc(var(--radius, 0.75rem) + 0.2rem);
          --ace-glass: hsl(var(--background, 36 45% 98%) / .66);
          --ace-glass-strong: hsl(var(--background, 36 45% 98%) / .82);
          --ace-glass-soft: hsl(var(--background, 36 45% 98%) / .52);
          --ace-glass-hover: hsl(var(--foreground, 24 6% 17%) / .08);
          --ace-glass-border: hsl(var(--foreground, 24 6% 17%) / .12);
          --ace-glass-border-strong: hsl(var(--foreground, 24 6% 17%) / .18);
          --ace-shadow: 0 18px 48px hsl(var(--foreground, 24 6% 17%) / .12);
          --ace-blur: blur(22px) saturate(135%);
        }
        #${GUI_DOCK_BUTTON_ID}{
          position:fixed;right:-34px;top:42vh;width:84px;height:118px;border:1px solid var(--ace-border);border-right:none;border-radius:var(--ace-radius) 0 0 var(--ace-radius);
          background:linear-gradient(180deg,var(--ace-glass-strong),var(--ace-glass));
          color:var(--ace-text);
          z-index:2147483000;opacity:.72;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
          font-family:var(--ace-font-sans);box-shadow:0 10px 30px hsl(var(--foreground, 24 6% 17%) / .12);transition:right .2s,opacity .2s,transform .2s;
          backdrop-filter:var(--ace-blur);-webkit-backdrop-filter:var(--ace-blur);border-color:var(--ace-glass-border-strong)
        }
        #${GUI_DOCK_BUTTON_ID}[data-open="true"],#${GUI_DOCK_BUTTON_ID}:hover{right:0;opacity:.98}
        #${GUI_DOCK_BUTTON_ID} .t1{font-size:13px;font-weight:700}
        #${GUI_DOCK_BUTTON_ID} .t2{font-size:11px;opacity:.78}
        #${GUI_PANEL_ID}{
          position:fixed;right:16px;top:70px;width:min(94vw,410px);max-height:min(84vh,800px);z-index:2147483001;
          background:
            linear-gradient(180deg,hsl(var(--background, 36 45% 98%) / .80),hsl(var(--background, 36 45% 98%) / .62));
          border:1px solid var(--ace-glass-border-strong);border-radius:calc(var(--ace-radius) + 2px);color:var(--ace-text);
          box-shadow:var(--ace-shadow);transform:translateX(16px) scale(.985);opacity:0;pointer-events:none;
          transition:transform .2s,opacity .2s;font-family:var(--ace-font-sans);overflow:hidden;
          backdrop-filter:var(--ace-blur);-webkit-backdrop-filter:var(--ace-blur)
        }
        #${GUI_PANEL_ID}[data-open="true"]{transform:translateX(0) scale(1);opacity:1;pointer-events:auto}
        #${GUI_PANEL_ID} .head{
          display:flex;justify-content:space-between;gap:8px;padding:12px 12px 8px;
          border-bottom:1px solid var(--ace-glass-border);
          background:linear-gradient(180deg,hsl(var(--background, 36 45% 98%) / .36),transparent)
        }
        #${GUI_PANEL_ID} .title{font-size:15px;font-weight:700;color:var(--ace-text)}
        #${GUI_PANEL_ID} .close{
          width:26px;height:26px;border:1px solid var(--ace-glass-border);border-radius:calc(var(--ace-radius) - 4px);
          background:var(--ace-glass-soft);color:var(--ace-text-secondary);cursor:pointer;font-size:17px;
          backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)
        }
        #${GUI_PANEL_ID} .close:hover{background:var(--ace-glass-hover)}
        #${GUI_PANEL_ID} .body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;max-height:calc(min(84vh,800px) - 58px);overflow-y:auto}
        #${GUI_PANEL_ID} .sec{
          border:1px solid var(--ace-glass-border);border-radius:var(--ace-radius);background:var(--ace-glass-soft);
          padding:9px;display:flex;flex-direction:column;gap:8px;
          backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)
        }
        #${GUI_PANEL_ID} .sec-h{display:flex;justify-content:space-between;align-items:center;gap:8px}
        #${GUI_PANEL_ID} .sec-t{font-size:13px;font-weight:700;color:var(--ace-text)}
        #${GUI_PANEL_ID} .helper{font-size:12px;color:var(--ace-text-muted)}
        #${GUI_PANEL_ID} .row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        #${GUI_PANEL_ID} .btn{
          border:1px solid var(--ace-glass-border);background:var(--ace-glass);color:var(--ace-text);border-radius:calc(var(--ace-radius) - 2px);
          padding:8px 10px;cursor:pointer;font-size:12px;line-height:1.2;white-space:nowrap;
          backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)
        }
        #${GUI_PANEL_ID} .btn:hover{background:var(--ace-glass-hover);border-color:var(--ace-glass-border-strong)}
        #${GUI_PANEL_ID} .btn.em{
          background:hsl(var(--foreground, 24 6% 17%) / .10);border-color:var(--ace-glass-border-strong);color:var(--ace-text);font-weight:700
        }
        #${GUI_PANEL_ID} .btn.em:hover{background:hsl(var(--foreground, 24 6% 17%) / .16);border-color:hsl(var(--foreground, 24 6% 17%) / .24)}
        #${GUI_PANEL_ID} .sel-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        #${GUI_PANEL_ID} .sel-sum{margin-left:auto;font-size:12px;color:var(--ace-text-muted)}
        #${GUI_PANEL_ID} .scope{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ace-text-muted)}
        #${GUI_PANEL_ID} .scope select{
          border:1px solid var(--ace-glass-border);background:var(--ace-glass);color:var(--ace-text);
          border-radius:calc(var(--ace-radius) - 4px);padding:5px 6px;font-size:12px;font-family:inherit
        }
        #${GUI_PANEL_ID} .badge{
          display:inline-block;margin-left:5px;padding:0 5px;border-radius:999px;font-size:10px;line-height:1.6;
          border:1px solid var(--ace-glass-border-strong);background:var(--ace-glass-soft);color:var(--ace-text-secondary)
        }
        #${GUI_PANEL_ID} .list{
          border:1px solid var(--ace-glass-border);border-radius:calc(var(--ace-radius) - 1px);
          background:hsl(var(--background, 36 45% 98%) / .40);max-height:280px;overflow-y:auto;
          backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)
        }
        #${GUI_PANEL_ID} .empty{padding:12px;font-size:12px;color:var(--ace-text-muted)}
        #${GUI_PANEL_ID} .item{display:flex;gap:9px;align-items:flex-start;padding:9px 10px;border-top:1px solid var(--ace-glass-border);cursor:pointer}
        #${GUI_PANEL_ID} .item:first-child{border-top:none}
        #${GUI_PANEL_ID} .item:hover{background:hsl(var(--foreground, 24 6% 17%) / .06)}
        #${GUI_PANEL_ID} .item-main{min-width:0;flex:1}
        #${GUI_PANEL_ID} .item-title{font-size:13px;line-height:1.35;word-break:break-word;color:var(--ace-text)}
        #${GUI_PANEL_ID} .item-meta{margin-top:3px;font-size:11px;color:var(--ace-text-muted)}
        #${GUI_PANEL_ID} .status{
          border-radius:calc(var(--ace-radius) - 2px);padding:8px 10px;font-size:12px;border:1px solid var(--ace-glass-border);
          background:var(--ace-glass-soft);color:var(--ace-text-secondary);
          backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)
        }
        #${GUI_PANEL_ID} .status[data-type="success"]{border-color:hsl(var(--interactive-positive, 125 49% 43%) / .24);background:hsl(var(--interactive-positive, 125 49% 43%) / .10);color:var(--ace-positive)}
        #${GUI_PANEL_ID} .status[data-type="error"]{border-color:hsl(var(--interactive-negative, 2 63% 54%) / .24);background:hsl(var(--interactive-negative, 2 63% 54%) / .10);color:var(--ace-negative)}
        #${GUI_PANEL_ID} .status[data-type="loading"]{border-color:hsl(var(--foreground, 24 6% 17%) / .18);background:hsl(var(--foreground, 24 6% 17%) / .06);color:var(--ace-text-secondary)}
        #${GUI_PANEL_ID}[data-busy="true"] button,#${GUI_PANEL_ID}[data-busy="true"] input[type="checkbox"]{opacity:.64}
      `;
      document.head.appendChild(style);

      const root = document.createElement("div");
      root.id = GUI_ROOT_ID;
      root.innerHTML = `
        <button id="${GUI_DOCK_BUTTON_ID}" type="button" aria-label="${t("dock_aria_open")}">
          <span class="t1">${t("dock_primary")}</span><span class="t2">${t("dock_secondary")}</span>
        </button>
        <section id="${GUI_PANEL_ID}" data-open="false" data-busy="false" aria-hidden="true">
          <div class="head">
            <div><div class="title">${t("panel_title")}</div></div>
            <button class="close" type="button" data-role="close" aria-label="${t("close_aria")}">×</button>
          </div>
          <div class="body">
            <div class="sec">
              <div class="sec-t">${t("section_current")}</div>
              <div class="row2">
                <button class="btn em" type="button" data-role="export-current-json">${t("button_download_json")}</button>
                <button class="btn" type="button" data-role="export-current-txt">${t("button_download_txt")}</button>
              </div>
              <button class="btn" type="button" data-role="export-current-both">${t("button_download_both")}</button>
            </div>
            <div class="sec">
              <div class="sec-h">
                <div class="sec-t">${t("section_history")}</div>
                <button class="btn" type="button" data-role="fetch-history">${t("button_fetch_history")}</button>
              </div>
              <div class="helper">${t("helper_history")}</div>
              <div class="sel-row">
                <label class="scope">${t("scope_label")}
                  <select data-role="history-scope">
                    <option value="all" selected>${t("scope_all")}</option>
                    <option value="active">${t("scope_active")}</option>
                    <option value="archived">${t("scope_archived")}</option>
                  </select>
                </label>
                <button class="btn" type="button" data-role="download-list">${t("button_download_list")}</button>
                <label class="scope">${t("parallel_label")}
                  <select data-role="export-parallel">
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3" selected>3</option>
                    <option value="4">4</option>
                    <option value="6">6</option>
                    <option value="8">8</option>
                  </select>
                </label>
              </div>
              <div class="sel-row">
                <button class="btn" type="button" data-role="select-all">${t("button_select_all")}</button>
                <button class="btn" type="button" data-role="clear-selection">${t("button_clear_selection")}</button>
                <span class="sel-sum" data-role="selection-summary">${t("selected_count", { count: 0 })}</span>
              </div>
              <div class="list" data-role="history-list"><div class="empty">${t("history_empty")}</div></div>
              <div class="row2">
                <button class="btn em" type="button" data-role="export-selected-json">${t("button_export_selected_json")}</button>
                <button class="btn" type="button" data-role="export-selected-txt">${t("button_export_selected_txt")}</button>
              </div>
              <div class="row2">
                <button class="btn" type="button" data-role="export-selected-both">${t("button_export_selected_both")}</button>
                <button class="btn em" type="button" data-role="export-all">${t("button_export_all")}</button>
              </div>
            </div>
            <div id="${GUI_STATUS_ID}" class="status" data-type="info">${t("status_prefix", { message: t("status_ready") })}</div>
          </div>
        </section>
      `;
      document.body.appendChild(root);

      const dockButton = document.getElementById(GUI_DOCK_BUTTON_ID);
      const panel = document.getElementById(GUI_PANEL_ID);
      const statusNode = document.getElementById(GUI_STATUS_ID);
      const closeNode = panel?.querySelector('[data-role="close"]');
      const exportCurrentJsonNode = panel?.querySelector('[data-role="export-current-json"]');
      const exportCurrentTxtNode = panel?.querySelector('[data-role="export-current-txt"]');
      const exportCurrentBothNode = panel?.querySelector('[data-role="export-current-both"]');
      const fetchHistoryNode = panel?.querySelector('[data-role="fetch-history"]');
      const historyScopeNode = panel?.querySelector('[data-role="history-scope"]');
      const downloadListNode = panel?.querySelector('[data-role="download-list"]');
      const exportParallelNode = panel?.querySelector('[data-role="export-parallel"]');
      const exportSelectedBothNode = panel?.querySelector('[data-role="export-selected-both"]');
      const exportAllNode = panel?.querySelector('[data-role="export-all"]');
      const selectAllNode = panel?.querySelector('[data-role="select-all"]');
      const clearSelectionNode = panel?.querySelector('[data-role="clear-selection"]');
      const exportSelectedJsonNode = panel?.querySelector('[data-role="export-selected-json"]');
      const exportSelectedTxtNode = panel?.querySelector('[data-role="export-selected-txt"]');
      const historyListNode = panel?.querySelector('[data-role="history-list"]');
      const selectionSummaryNode = panel?.querySelector('[data-role="selection-summary"]');

      if (
        !dockButton ||
        !panel ||
        !statusNode ||
        !exportCurrentJsonNode ||
        !exportCurrentTxtNode ||
        !exportCurrentBothNode ||
        !fetchHistoryNode ||
        !historyScopeNode ||
        !downloadListNode ||
        !exportParallelNode ||
        !exportSelectedBothNode ||
        !exportAllNode ||
        !selectAllNode ||
        !clearSelectionNode ||
        !exportSelectedJsonNode ||
        !exportSelectedTxtNode ||
        !historyListNode ||
        !selectionSummaryNode
      ) {
        warn(t("gui_init_failed"));
        return;
      }

      const state = {
        isBusy: false,
        historyItems: [],
        selectedKeys: new Set(),
        historyScope: "all",
        concurrency: DEFAULT_CONCURRENCY,
      };

      function setStatus(message, type) {
        statusNode.textContent = t("status_prefix", { message });
        statusNode.setAttribute("data-type", type || "info");
      }

      function setBusy(nextBusy) {
        state.isBusy = Boolean(nextBusy);
        panel.setAttribute("data-busy", state.isBusy ? "true" : "false");
        dockButton.setAttribute("data-busy", state.isBusy ? "true" : "false");
      }

      function setPanelOpen(nextOpen) {
        const isOpen = Boolean(nextOpen);
        panel.setAttribute("data-open", isOpen ? "true" : "false");
        panel.setAttribute("aria-hidden", isOpen ? "false" : "true");
        dockButton.setAttribute("data-open", isOpen ? "true" : "false");
      }

      function getScopeSelection() {
        const scope = String(historyScopeNode.value || state.historyScope || "all");
        if (scope === "active") {
          return { scope: "active", includeArchived: false, archivedOnly: false };
        }
        if (scope === "archived") {
          // Mirrors the site's own "Archived" filter: archivedOnly=true, no includeArchived.
          return { scope: "archived", includeArchived: false, archivedOnly: true };
        }
        return { scope: "all", includeArchived: true, archivedOnly: false };
      }

      function getConcurrency() {
        return normalizeConcurrency(exportParallelNode.value || state.concurrency);
      }

      function formatBatchProgress(formatLabel, progress) {
        const total = Number(progress?.total || 0);
        const index = Number(progress?.index || 0);
        const elapsed = Number(progress?.elapsedMs || 0);
        let suffix = "";
        if (index > 1 && index < total && elapsed > 0) {
          const remaining = Math.round((elapsed / index) * (total - index));
          if (remaining > 1500) {
            suffix += t("status_eta_suffix", { left: formatDuration(remaining) });
          }
        }
        if (Number(progress?.failedCount || 0) > 0) {
          suffix += t("status_failed_suffix", { failed: progress.failedCount });
        }
        return `${t("label_export_selected", { format: formatLabel })} ${index}/${total}${suffix}`;
      }

      function describeBatchResult(result) {
        if (result.manifestOnly) {
          return t("batch_done_manifest_only", { failed: result.failedCount });
        }
        if (result.failedCount > 0) {
          return result.packaged
            ? t("batch_done_packaged_success_failed", {
                success: result.successCount,
                failed: result.failedCount,
              })
            : t("batch_done_success_failed", {
                success: result.successCount,
                failed: result.failedCount,
              });
        }
        return result.packaged
          ? t("batch_done_packaged_success", { success: result.successCount })
          : t("batch_done_success", { success: result.successCount });
      }

      function mapHistoryItems(history) {
        return (Array.isArray(history) ? history : [])
          .filter((item) => extractConversationId(item?.id))
          .map((item) => ({
            id: extractConversationId(item.id),
            type: isAgentHistoryItem(item) ? "agentic" : "evaluation",
            title: String(item?.title || t("untitled")),
            mode: String(item?.mode || "unknown"),
            createdAt: item?.createdAt || "",
            updatedAt: item?.updatedAt || "",
            archivedAt: typeof item?.archivedAt === "string" ? item.archivedAt : "",
          }));
      }

      function countArchived(items) {
        return (Array.isArray(items) ? items : []).filter((item) => Boolean(item?.archivedAt))
          .length;
      }

      function updateSelectionSummary() {
        const selectedItems = state.historyItems.filter((item) =>
          state.selectedKeys.has(getHistoryItemKey(item))
        );
        const archivedCount = countArchived(selectedItems);
        selectionSummaryNode.textContent = archivedCount
          ? t("selected_count_archived", {
              count: selectedItems.length,
              archived: archivedCount,
            })
          : t("selected_count", { count: selectedItems.length });
      }

      function renderHistoryList() {
        historyListNode.innerHTML = "";
        if (!state.historyItems.length) {
          historyListNode.innerHTML = `<div class="empty">${t("history_empty")}</div>`;
          updateSelectionSummary();
          return;
        }

        const fragment = document.createDocumentFragment();
        for (const item of state.historyItems) {
          const row = document.createElement("label");
          row.className = "item";
          row.innerHTML = `
            <input type="checkbox" />
            <div class="item-main">
              <div class="item-title"></div>
              <div class="item-meta"></div>
            </div>
          `;
          const checkbox = row.querySelector('input[type="checkbox"]');
          const titleNode = row.querySelector(".item-title");
          const metaNode = row.querySelector(".item-meta");
          if (!checkbox || !titleNode || !metaNode) {
            continue;
          }
          const archivedAt = typeof item.archivedAt === "string" ? item.archivedAt : "";
          if (archivedAt) {
            row.setAttribute("data-archived", "true");
          }
          titleNode.textContent = truncateText(item.title || t("untitled"), 92);
          metaNode.textContent = `${
            item.type === "agentic" ? "agentic" : item.mode || "unknown"
          } | ${formatUiTime(item.createdAt)}`;
          if (archivedAt) {
            const badgeNode = document.createElement("span");
            badgeNode.className = "badge";
            badgeNode.textContent = `${t("badge_archived")} ${formatUiTime(archivedAt)}`;
            metaNode.appendChild(badgeNode);
          }
          const itemKey = getHistoryItemKey(item);
          checkbox.checked = state.selectedKeys.has(itemKey);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              state.selectedKeys.add(itemKey);
            } else {
              state.selectedKeys.delete(itemKey);
            }
            updateSelectionSummary();
          });
          fragment.appendChild(row);
        }
        historyListNode.appendChild(fragment);
        updateSelectionSummary();
      }

      async function runGuiAction(label, task) {
        if (state.isBusy) {
          return;
        }
        setBusy(true);
        setStatus(t("status_running", { label }), "loading");
        try {
          const message = await task();
          setStatus(message || t("status_done", { label }), "success");
        } catch (error) {
          const message = toErrorMessage(error);
          warn("gui action failed", label, message);
          setStatus(t("status_failed", { label, message }), "error");
        } finally {
          setBusy(false);
        }
      }

      async function handleFetchHistory() {
        await runGuiAction(t("label_fetch_history"), async () => {
          const scope = getScopeSelection();
          state.historyScope = scope.scope;
          const history = await fetchHistoryList(
            HISTORY_PAGE_GUARD,
            { includeArchived: scope.includeArchived, archivedOnly: scope.archivedOnly },
            {
              onPageRequest(progress) {
                setStatus(
                  t("fetch_page_request", {
                    page: progress.page,
                    count: progress.totalCount,
                  }),
                  "loading"
                );
              },
              onPageLoaded(progress) {
                setStatus(
                  t("fetch_page_loaded", {
                    page: progress.page,
                    count: progress.totalCount,
                  }),
                  "loading"
                );
              },
            }
          );
          const mapped = mapHistoryItems(history);
          state.historyItems = mapped;
          state.selectedKeys.clear();
          renderHistoryList();
          const archivedCount = countArchived(state.historyItems);
          if (history.length >= HISTORY_PAGE_GUARD * DEFAULT_HISTORY_PAGE_SIZE) {
            return t("fetch_guard_hit", {
              count: state.historyItems.length,
              archived: archivedCount,
            });
          }
          return t("fetch_complete", {
            count: state.historyItems.length,
            archived: archivedCount,
          });
        });
      }

      async function handleDownloadList() {
        await runGuiAction(t("label_download_list"), async () => {
          if (!state.historyItems.length) {
            throw new Error(t("no_history_items"));
          }
          const archivedCount = countArchived(state.historyItems);
          const payload = {
            exporter: "Arena.ai / LMSYS Arena Chat Exporter",
            version: EXPORTER_VERSION,
            exportedAt: new Date().toISOString(),
            source: location.origin,
            scope: state.historyScope || "all",
            counts: {
              total: state.historyItems.length,
              archived: archivedCount,
              active: state.historyItems.length - archivedCount,
            },
            items: state.historyItems.map((item) => ({
              id: item.id,
              type: item.type,
              title: item.title,
              mode: item.mode,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              archivedAt: item.archivedAt || null,
            })),
          };
          const time = new Date().toISOString().replace(/[:.]/g, "-");
          downloadBlob(
            `arena-chat-list-${payload.scope}-${time}.json`,
            "application/json;charset=utf-8",
            `${JSON.stringify(payload, null, 2)}\n`
          );
          return t("list_download_done", {
            count: state.historyItems.length,
            archived: archivedCount,
          });
        });
      }

      async function handleExportCurrent(format) {
        const formatLabel =
          format === "both" ? "JSON + TXT" : format === "txt" ? "TXT" : "JSON";
        await runGuiAction(t("label_download_current", { format: formatLabel }), async () => {
          await exportCurrentConversation(format);
          return t("current_download_done", { format: formatLabel });
        });
      }

      function buildBatchHooks(formatLabel) {
        return {
          onProgress(progress) {
            setStatus(
              t("status_running", { label: formatBatchProgress(formatLabel, progress) }),
              "loading"
            );
          },
          onZipProgressStart() {
            setStatus(t("zip_packing", { format: formatLabel }), "loading");
          },
          onZipProgress(metadata) {
            const percent = Math.max(
              0,
              Math.min(100, Math.round(Number(metadata?.percent || 0)))
            );
            setStatus(
              t("zip_packing_progress", { format: formatLabel, percent }),
              "loading"
            );
          },
        };
      }

      function formatsLabel(formatList) {
        return formatList.length > 1 ? "JSON + TXT" : formatList[0] === "txt" ? "TXT" : "JSON";
      }

      async function handleExportSelected(formats) {
        const formatList = Array.isArray(formats) ? formats : [formats];
        const label = formatsLabel(formatList);
        await runGuiAction(t("label_export_selected", { format: label }), async () => {
          const selectedItems = state.historyItems.filter((item) =>
            state.selectedKeys.has(getHistoryItemKey(item))
          );
          if (!selectedItems.length) {
            throw new Error(t("no_selected_items"));
          }
          const scope = getScopeSelection();
          state.historyScope = scope.scope;
          const concurrency = getConcurrency();
          const result = await exportBatchConversations(
            selectedItems,
            formatList,
            buildBatchHooks(label),
            {
              listScope: scope.scope,
              archivedCount: countArchived(selectedItems),
            },
            { concurrency }
          );
          return describeBatchResult(result);
        });
      }

      async function handleExportAll() {
        await runGuiAction(t("label_export_all"), async () => {
          const scope = getScopeSelection();
          state.historyScope = scope.scope;
          const concurrency = getConcurrency();
          const history = await fetchHistoryList(
            HISTORY_PAGE_GUARD,
            { includeArchived: scope.includeArchived, archivedOnly: scope.archivedOnly },
            {
              onPageRequest(progress) {
                setStatus(
                  t("fetch_page_request", {
                    page: progress.page,
                    count: progress.totalCount,
                  }),
                  "loading"
                );
              },
              onPageLoaded(progress) {
                setStatus(
                  t("fetch_page_loaded", {
                    page: progress.page,
                    count: progress.totalCount,
                  }),
                  "loading"
                );
              },
            }
          );
          const mapped = mapHistoryItems(history);
          state.historyItems = mapped;
          state.selectedKeys = new Set(mapped.map((item) => getHistoryItemKey(item)));
          renderHistoryList();
          if (!mapped.length) {
            throw new Error(t("no_history_items"));
          }
          const result = await exportBatchConversations(
            mapped,
            ["json", "txt"],
            buildBatchHooks("JSON + TXT"),
            {
              listScope: scope.scope,
              archivedCount: countArchived(mapped),
              exportedEverything: true,
            },
            { concurrency }
          );
          return t("export_all_done", {
            success: result.successCount,
            failed: result.failedCount,
          });
        });
      }

      dockButton.addEventListener("click", () => {
        const isOpen = panel.getAttribute("data-open") === "true";
        setPanelOpen(!isOpen);
      });
      closeNode?.addEventListener("click", () => setPanelOpen(false));

      exportCurrentJsonNode.addEventListener("click", () => handleExportCurrent("json"));
      exportCurrentTxtNode.addEventListener("click", () => handleExportCurrent("txt"));
      exportCurrentBothNode.addEventListener("click", () => handleExportCurrent("both"));
      fetchHistoryNode.addEventListener("click", () => handleFetchHistory());
      downloadListNode.addEventListener("click", () => handleDownloadList());
      historyScopeNode.addEventListener("change", () => {
        state.historyScope = String(historyScopeNode.value || "all");
      });
      exportParallelNode.addEventListener("change", () => {
        state.concurrency = normalizeConcurrency(exportParallelNode.value);
      });

      selectAllNode.addEventListener("click", () => {
        for (const item of state.historyItems) {
          state.selectedKeys.add(getHistoryItemKey(item));
        }
        renderHistoryList();
        setStatus(t("selected_all_done"), "info");
      });
      clearSelectionNode.addEventListener("click", () => {
        state.selectedKeys.clear();
        renderHistoryList();
        setStatus(t("cleared_selection_done"), "info");
      });

      exportSelectedJsonNode.addEventListener("click", () => handleExportSelected("json"));
      exportSelectedTxtNode.addEventListener("click", () => handleExportSelected("txt"));
      exportSelectedBothNode.addEventListener("click", () =>
        handleExportSelected(["json", "txt"])
      );
      exportAllNode.addEventListener("click", () => handleExportAll());

      document.addEventListener("click", (event) => {
        if (panel.getAttribute("data-open") !== "true") {
          return;
        }
        const target = event.target;
        if (!(target instanceof Node)) {
          return;
        }
        if (panel.contains(target) || dockButton.contains(target)) {
          return;
        }
        setPanelOpen(false);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && panel.getAttribute("data-open") === "true") {
          setPanelOpen(false);
        }
      });

      renderHistoryList();
      setStatus(t("status_ready"), "info");
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
  }

  installGui();

  window.__arenaChatExport = async function __arenaChatExport(conversationId, format, type) {
    return await exportHistoryItem(
      {
        id: conversationId,
        type: type === "agentic" ? "agentic" : "evaluation",
      },
      format || "json"
    );
  };

  log(`ready v${EXPORTER_VERSION}`);
})();
