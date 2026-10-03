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
      /* __FFLATE_UMD__ */
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
