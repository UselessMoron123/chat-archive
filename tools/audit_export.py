#!/usr/bin/env python3
"""Audit Arena.ai chat exporter ZIP archives.

Reads the TXT (or JSON) exports straight out of ZIP files - nothing is unpacked
to disk - and answers the questions that matter before you trust a batch:

  * did every selected chat make it into the archive (manifest counts, id lists)?
  * are the same chats exported twice, and do the passes agree?
  * does the batch cover a previously saved conversation list?
  * compared with an older batch, did any chat get *smaller* (a regression)?

Examples
--------
    # audit one batch against the account list saved earlier
    python3 tools/audit_export.py --zips "latest try" \
        --list "latest try/arena-chat-list-all-2026-10-03T16-39-49-640Z.json"

    # audit and compare with the previous batch
    python3 tools/audit_export.py --zips "latest try" \
        --list "latest try/arena-chat-list-all-2026-10-03T16-39-49-640Z.json" \
        --baseline arena-chat-export-txt-2026-10-03T15-23-15-756Z.zip

    # JSON batches work the same way (id comes from the record, not the header)
    python3 tools/audit_export.py --zips "check this out/export attempt"

Exit code is 1 when a regression, a missing chat or a failed export is found,
so the script can be used in a loop or a pre-backup check.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict

TOOL_RE = re.compile(r"^\[tool: ([a-z0-9_]+)\]$", re.M)
NOTICE_RE = re.compile(r"^\[notice: (.*)\]$", re.M)
CONV_URL_RE = re.compile(r"arena\.ai/(?:agent|agents|c)/([0-9a-f-]{36})", re.I)
HEADER_RE = re.compile(r"^(Title|Type|Mode|Started|Updated|Archived|Messages|URL)\s*:\s*(.*)$", re.M)
MESSAGE_BLOCK_RE = re.compile(r"^Message  : \d+$", re.M)


def iter_zip_paths(targets: list[str]) -> list[str]:
    paths: list[str] = []
    for target in targets:
        if os.path.isdir(target):
            for root, _dirs, files in os.walk(target):
                paths.extend(os.path.join(root, f) for f in sorted(files) if f.lower().endswith(".zip"))
        elif target.lower().endswith(".zip"):
            paths.append(target)
        else:
            print(f"warning: {target} is neither a directory nor a .zip", file=sys.stderr)
    return paths


def read_zip_entries(path: str) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as zf:
        bad = zf.testzip()
        if bad:
            raise RuntimeError(f"{path}: corrupt member {bad}")
        return {info.filename: zf.read(info.filename) for info in zf.infolist() if not info.is_dir()}


class Chat:
    """One exported conversation, parsed from either a TXT or a JSON record."""

    __slots__ = ("id", "type", "title", "messages", "chars", "archived_at", "tools", "notices",
                 "reasoning_blocks", "empty_markers", "source", "problems", "kind")

    def __init__(self, source: str):
        self.source = source
        self.kind = "json" if source.lower().endswith(".json") else "txt"
        self.id = None
        self.type = None
        self.title = None
        self.messages = None
        self.chars = 0
        self.archived_at = None
        self.tools: Counter = Counter()
        self.notices: Counter = Counter()
        self.reasoning_blocks = 0
        self.empty_markers = 0
        self.problems: list[str] = []

    @classmethod
    def from_text(cls, name: str, raw: bytes) -> "Chat":
        chat = cls(name)
        text = raw.decode("utf-8", errors="replace")
        chat.chars = len(text)
        # Only the block above the first separator is the real header; chat bodies
        # often quote the export format (these chats are about the exporter), and
        # parsing the whole file would pick up those quoted lines instead.
        header_match = re.search(r"\n-{10,}", text)
        header_text = text[: header_match.start()] if header_match else text[:2000]
        header: dict[str, str] = {}
        for key, value in HEADER_RE.findall(header_text):
            header.setdefault(key, value)  # first wins
        chat.title = header.get("Title")
        chat.type = (header.get("Type") or "evaluation").strip()
        chat.archived_at = header.get("Archived")
        if header.get("Messages") and header["Messages"].lstrip("-").isdigit():
            chat.messages = int(header["Messages"])
        url = header.get("URL") or ""
        match = CONV_URL_RE.search(url)
        if match:
            chat.id = match.group(1).lower()
        else:
            chat.problems.append("no conversation id in the URL header")
        blocks = len(MESSAGE_BLOCK_RE.findall(text[header_match.end():] if header_match else text))
        if chat.messages is not None and blocks < chat.messages:
            chat.problems.append(f"header claims {chat.messages} messages, but only {blocks} are present")
        chat.reasoning_blocks = text.count("[reasoning]")
        chat.empty_markers = text.count("(empty)")
        chat.tools.update(TOOL_RE.findall(text))
        chat.notices.update(re.sub(r"\(.*", "", n).strip() for n in NOTICE_RE.findall(text))
        return chat

    @classmethod
    def from_json(cls, name: str, raw: bytes) -> "Chat":
        chat = cls(name)
        text = raw.decode("utf-8", errors="replace")
        chat.chars = len(text)
        payload = json.loads(text)
        record = payload.get("evaluation") or payload.get("agent") or {}
        chat.id = str(record.get("id") or "").lower() or None
        chat.type = "agentic" if payload.get("recordType") == "agentic" else "evaluation"
        chat.title = record.get("title")
        chat.archived_at = payload.get("archivedAt") or record.get("archivedAt")
        messages = record.get("messages")
        chat.messages = len(messages) if isinstance(messages, list) else None
        if not chat.id:
            chat.problems.append("no id in the JSON record")
        return chat


def load_chats(zip_path: str) -> tuple[dict, list[Chat], list[dict]]:
    entries = read_zip_entries(zip_path)
    manifest = None
    chats: list[Chat] = []
    for name, raw in entries.items():
        if name.lower().endswith("manifest.json"):
            try:
                manifest = json.loads(raw.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                manifest = {"unparsable": True}
            continue
        try:
            if name.lower().endswith(".json"):
                chats.append(Chat.from_json(name, raw))
            elif name.lower().endswith(".txt"):
                chats.append(Chat.from_text(name, raw))
        except Exception as error:  # noqa: BLE001 - report, do not crash the audit
            broken = Chat(name)
            broken.problems.append(f"failed to parse: {error}")
            chats.append(broken)
    return manifest, chats, list(manifest["failedExports"]) if manifest and isinstance(manifest.get("failedExports"), list) else []


def load_saved_list(path: str) -> dict[str, dict]:
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    items = payload.get("items") if isinstance(payload, dict) else None
    if items is None and isinstance(payload, dict):
        items = payload.get("successfulExports")
    if items is None and isinstance(payload, list):
        items = payload
    result: dict[str, dict] = {}
    for item in items or []:
        if isinstance(item, str):
            match = CONV_URL_RE.search(item)
            cid = match.group(1).lower() if match else None
            if cid:
                result[cid] = {"title": "", "archivedAt": None}
            continue
        cid = str(item.get("id") or item.get("conversationId") or "").lower()
        if cid:
            result[cid] = {"title": item.get("title") or "", "archivedAt": item.get("archivedAt")}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zips", nargs="+", required=True, help="ZIP files and/or directories containing them")
    parser.add_argument("--list", help="a saved arena-chat-list-*.json (or a previous manifest.json) to check coverage against")
    parser.add_argument("--baseline", nargs="*", default=[], help="older ZIP batches to compare against (each chat must not shrink)")
    parser.add_argument("--quiet", action="store_true", help="only print problems and the summary")
    args = parser.parse_args()

    zip_paths = iter_zip_paths(args.zips)
    if not zip_paths:
        print("no ZIP archives found", file=sys.stderr)
        return 1

    print(f"# batches: {len(zip_paths)}")
    all_chats: dict[str, list[Chat]] = defaultdict(list)
    failed_total = 0
    problems: list[str] = []

    for zip_path in zip_paths:
        manifest, chats, failed = load_chats(zip_path)
        label = os.path.basename(zip_path)
        counts = ""
        if manifest:
            counts = (f" | manifest: selected={manifest.get('selectedCount')} ok={manifest.get('successCount')} "
                      f"failed={manifest.get('failedCount')} archived={manifest.get('archivedCount')} "
                      f"scope={manifest.get('listScope')} v{manifest.get('version')}")
            if manifest.get("failedCount"):
                failed_total += int(manifest["failedCount"])
        print(f"  {label}: files={len(chats)}{counts}")
        for item in failed:
            problems.append(f"{label}: failed export {item.get('conversationId')} ({(item.get('title') or '')[:50]})")
        for chat in chats:
            if chat.problems:
                problems.extend(f"{label} / {chat.source}: {p}" for p in chat.problems)
            if chat.id:
                all_chats[chat.id].append(chat)

    total_chars = sum(max(c.chars for c in group) for group in all_chats.values())
    total_msgs = sum(c.messages or 0 for group in all_chats.values() for c in group[:1])
    print(f"\n# unique conversations: {len(all_chats)} | messages: {total_msgs} | text: {total_chars:,} chars")

    duplicates = {cid: group for cid, group in all_chats.items() if len(group) > 1}
    if duplicates:
        identical = 0
        cross_format = 0
        for cid, group in duplicates.items():
            by_kind: dict[str, set] = defaultdict(set)
            for chat in group:
                by_kind[chat.kind].add((chat.messages, chat.chars))
            if len(by_kind) > 1:
                cross_format += 1
            conflicting = [kind for kind, signatures in by_kind.items() if len(signatures) > 1]
            if not conflicting:
                identical += 1
            else:
                problems.append(
                    f"repeated export of {cid} differs within the same format: "
                    + ", ".join(f"{kind} {sorted(by_kind[kind])}" for kind in conflicting)
                )
        print(f"# exported more than once: {len(duplicates)} (identical within each format: {identical}"
              + (f", {cross_format} also present in the other format" if cross_format else "") + ")")

    tools = Counter()
    notices = Counter()
    for group in all_chats.values():
        best = max(group, key=lambda c: c.chars)
        tools.update(best.tools)
        notices.update(best.notices)
    if tools:
        print("# tools:", dict(tools))
    if notices:
        print("# notices:", dict(notices))

    if args.list:
        expected = load_saved_list(args.list)
        missing = sorted(set(expected) - set(all_chats))
        extra = sorted(set(all_chats) - set(expected))
        print(f"\n# saved list {os.path.basename(args.list)}: {len(expected)} chats")
        flag_mismatch = [
            cid for cid, meta in expected.items()
            if cid in all_chats and bool(meta.get("archivedAt")) != bool(all_chats[cid][0].archived_at)
        ]
        print(f"#   missing from the export: {len(missing)} | not in the saved list: {len(extra)} "
              f"| archive-flag mismatches: {len(flag_mismatch)}")
        for cid in missing[:20]:
            print(f"      MISSING {cid} | {(expected[cid].get('title') or '')[:70]}")
        for cid in extra[:20]:
            print(f"      EXTRA   {cid} | {(all_chats[cid][0].title or '')[:70]}")
        if missing:
            problems.append(f"{len(missing)} chats from the saved list are absent from the export")
        if flag_mismatch:
            problems.append(f"{len(flag_mismatch)} chats disagree with the saved list about the archive flag")

    if args.baseline:
        base_chats: dict[str, Chat] = {}
        for path in iter_zip_paths(args.baseline):
            _manifest, chats, _failed = load_chats(path)
            for chat in chats:
                if chat.id and (chat.id not in base_chats or chat.chars > base_chats[chat.id].chars):
                    base_chats[chat.id] = chat
        shared = sorted(set(base_chats) & set(all_chats))
        regressions: list[str] = []
        richer = 0
        cross_format_pairs = 0
        for cid in shared:
            old = base_chats[cid]
            new = max(all_chats[cid], key=lambda c: c.chars)
            same_format = old.kind == new.kind
            if not same_format:
                cross_format_pairs += 1
            delta_msgs = (new.messages or 0) - (old.messages or 0)
            delta_chars = new.chars - old.chars
            lost_tools = {k: (old.tools[k], new.tools[k]) for k in old.tools if new.tools[k] < old.tools[k]}
            # character counts are only comparable within one representation
            chars_worse = same_format and delta_chars < -2000
            chars_better = same_format and delta_chars > 2000
            if delta_msgs < 0 or chars_worse or lost_tools:
                detail = f"messages {old.messages}->{new.messages}, tools {lost_tools}"
                if same_format:
                    detail = f"messages {old.messages}->{new.messages}, chars {old.chars}->{new.chars}, tools {lost_tools}"
                regressions.append(f"{cid}: {detail}")
            elif delta_msgs > 0 or chars_better or (same_format and new.chars != old.chars):
                richer += 1
        print(f"\n# baseline comparison: {len(shared)} shared chats | unchanged/changed: {len(shared) - len(regressions)} | regressions: {len(regressions)}")
        if cross_format_pairs:
            print(f"#   {cross_format_pairs} chats were compared across formats; only messages and tool counts are used there")
        for line in regressions[:20]:
            print(f"      REGRESSION {line}")
        if regressions:
            problems.append(f"{len(regressions)} chats regressed against the baseline")
        if not args.quiet:
            print(f"#   (chats with any content change: {richer})")

    print(f"\n# result: {'PROBLEMS FOUND' if problems or failed_total else 'OK'}")
    for line in problems[:40]:
        print(f"  - {line}")
    if len(problems) > 40:
        print(f"  ... and {len(problems) - 40} more")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
