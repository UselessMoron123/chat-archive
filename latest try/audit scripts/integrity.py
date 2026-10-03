#!/usr/bin/env python3
"""Stage 2: integrity + completeness checks for the 'latest try' TXT export."""
import glob, json, os, re, statistics
from collections import Counter, defaultdict

def parse(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    url = re.search(r"^URL      : (.*)$", text, re.M)
    msgs_hdr = re.search(r"^Messages : (\d+)$", text, re.M)
    typ = re.search(r"^Type     : (.*)$", text, re.M)
    blocks = len(re.findall(r"^Message  : \d+$", text, re.M))
    return {
        "path": path,
        "chars": len(text),
        "id": (re.search(r"arena\.ai/(?:agent|c)/([0-9a-f-]{36})", url.group(1), re.I).group(1).lower()
               if url and re.search(r"arena\.ai/(?:agent|c)/([0-9a-f-]{36})", url.group(1), re.I) else None),
        "type": typ.group(1).strip() if typ else None,
        "msgs_hdr": int(msgs_hdr.group(1)) if msgs_hdr else None,
        "blocks": blocks,
        "has_header": "arena.ai agent chat export" in text or "arena.ai chat export" in text,
        "truncated_file": not text.endswith("\n"),
        "fetch_page_sections": len(re.findall(r"^\[tool: fetch_page\]$", text, re.M)),
        "read_file_with_content": len(re.findall(r"\[tool: read_file\]", text)),
        "web_search_results": len(re.findall(r"^\[tool: web_search\]$", text, re.M)),
    }

files = [parse(p) for p in glob.glob("/tmp/audit/new/**/*.txt", recursive=True)]
# de-duplicate by (id, chars) so the two passes do not double count
uniq = {}
for f in files:
    uniq[(f["id"], f["chars"])] = f
uniq = list(uniq.values())
print(f"unique conversation exports: {len(uniq)} (from {len(files)} files)")

bad_header = [f for f in uniq if not f["has_header"]]
bad_counts = [f for f in uniq if f["msgs_hdr"] != f["blocks"]]
zero_msg = [f for f in uniq if not f["msgs_hdr"]]
no_id = [f for f in uniq if not f["id"]]
print(f"files without export header : {len(bad_header)}")
print(f"message-count mismatches    : {len(bad_counts)}")
print(f"zero-message conversations  : {len(zero_msg)}")
print(f"files without conversation id: {len(no_id)}")
for f in bad_counts[:10]:
    print("   MISMATCH", os.path.basename(f["path"])[:70], f["msgs_hdr"], "!=", f["blocks"])
for f in zero_msg[:10]:
    print("   ZERO", os.path.basename(f["path"])[:70])

chars = sorted(f["chars"] for f in uniq)
print(f"\nsize per conversation: min={chars[0]:,} p10={chars[len(chars)//10]:,} "
      f"median={int(statistics.median(chars)):,} p90={chars[9*len(chars)//10]:,} max={chars[-1]:,}")
small = [f for f in uniq if f["chars"] < 1500]
print(f"very small exports (<1.5 KB): {len(small)}")
for f in sorted(small, key=lambda x: x["chars"])[:10]:
    print("   ", f"{f['chars']:6,}", f["type"], (f["id"] or "?")[:8], os.path.basename(f["path"])[:60])

by_type = Counter(f["type"] for f in uniq)
print(f"\nby type: {dict(by_type)}")
for t in by_type:
    sel = [f for f in uniq if f["type"] == t]
    print(f"  {t}: files={len(sel)} median_chars={int(statistics.median(f['chars'] for f in sel)):,} "
          f"fetch_page={sum(f['fetch_page_sections'] for f in sel)} read_file={sum(f['read_file_with_content'] for f in sel)} "
          f"web_search={sum(f['web_search_results'] for f in sel)}")

with_tools = [f for f in uniq if f["fetch_page_sections"] or f["read_file_with_content"] or f["web_search_results"]]
print(f"\nconversations containing recorded tool calls: {len(with_tools)}")

# agentic exports that contain no tool calls at all (could indicate HTML fetch failed)
agentic = [f for f in uniq if f["type"] == "agentic"]
no_tools = [f for f in agentic if not (f["fetch_page_sections"] or f["read_file_with_content"] or f["web_search_results"])]
print(f"agentic conversations without any tool call: {len(no_tools)} / {len(agentic)}")
print("   (agentic chats can legitimately have no tools - short or pure-text sessions)")
for f in sorted(no_tools, key=lambda x: x["chars"])[:8]:
    print("   ", f"{f['chars']:7,}", (f["id"] or "?")[:8], os.path.basename(f["path"])[:60])

# spot check one archived agentic chat body vs header
oldest = sorted(agentic, key=lambda x: x["chars"])[0]
if oldest:
    text = open(oldest["path"], encoding="utf-8", errors="replace").read()
    print("\n--- sample of smallest agentic export (first 700 chars) ---")
    print(text[:700])
