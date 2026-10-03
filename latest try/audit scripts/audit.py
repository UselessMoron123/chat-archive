#!/usr/bin/env python3
"""Audit the 'latest try' export batch vs earlier exports."""
import glob, json, os, re, sys
from collections import Counter, defaultdict

NEW_DIR = os.path.expanduser("~/chat-archive/latest try")
EXTRACT_NEW = "/tmp/audit/new"
EXTRACT_OLD = "/tmp/audit/old"

HEADER_RE = {
    "title": re.compile(r"^Title    : (.*)$", re.M),
    "type": re.compile(r"^Type     : (.*)$", re.M),
    "messages": re.compile(r"^Messages : (\d+)$", re.M),
    "url": re.compile(r"^URL      : (.*)$", re.M),
    "archived": re.compile(r"^Archived : (.*)$", re.M),
    "started": re.compile(r"^Started  : (.*)$", re.M),
    "updated": re.compile(r"^Updated  : (.*)$", re.M),
    "mode": re.compile(r"^Mode     : (.*)$", re.M),
}
CONV_ID_RE = re.compile(r"arena\.ai/(?:agent|c)/([0-9a-f-]{36})", re.I)
TOOL_RE = re.compile(r"^\[tool: ([a-z0-9_]+)\]$", re.M)
NOTICE_RE = re.compile(r"^\[notice: (.*)\]$", re.M)


def parse_txt(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    info = {"path": path, "chars": len(text), "id": None, "tools": Counter(),
            "notices": Counter(), "reasoning_blocks": text.count("[reasoning]"),
            "file_blocks": text.count("[file]"), "empty_markers": text.count("(empty)")}
    for key, rx in HEADER_RE.items():
        m = rx.search(text)
        info[key] = m.group(1).strip() if m else None
    if info["url"]:
        m = CONV_ID_RE.search(info["url"])
        info["id"] = m.group(1).lower() if m else None
    info["messages"] = int(info["messages"]) if info["messages"] else None
    for name in TOOL_RE.findall(text):
        info["tools"][name] += 1
    for note in NOTICE_RE.findall(text):
        key = re.sub(r"\(.*", "", note).strip()
        info["notices"][key] += 1
    return info


def load_dir(root):
    items = []
    for path in glob.glob(os.path.join(root, "**", "*.txt"), recursive=True):
        items.append(parse_txt(path))
    return items


new_items = load_dir(EXTRACT_NEW)
old_items = [i for i in load_dir(EXTRACT_OLD) if i["type"] == "agentic" or True]

print(f"new TXT files parsed: {len(new_items)}")
print(f"old TXT files parsed: {len(old_items)}")

new_by_id = defaultdict(list)
for i in new_items:
    new_by_id[i["id"] or "NO-ID"].append(i)
old_by_id = defaultdict(list)
for i in old_items:
    old_by_id[i["id"] or "NO-ID"].append(i)

print(f"new unique conversation ids: {len([k for k in new_by_id if k != 'NO-ID'])}")
print(f"old unique conversation ids: {len([k for k in old_by_id if k != 'NO-ID'])}")

# --- duplicates in the new batch -------------------------------------------------
dups = {k: v for k, v in new_by_id.items() if len(v) > 1 and k != "NO-ID"}
print(f"\nnew batch: conversations exported more than once: {len(dups)} "
      f"(extra files: {sum(len(v) - 1 for v in dups.values())})")
same = 0
diff = []
for k, v in sorted(dups.items()):
    counts = {x["messages"] for x in v}
    chars = {x["chars"] for x in v}
    if len(counts) == 1 and len(chars) == 1:
        same += 1
    else:
        diff.append((k, sorted(counts), sorted(chars), [os.path.basename(x["path"])[:60] for x in v]))
print(f"  identical duplicates: {same}; differing duplicates: {len(diff)}")
for row in diff[:15]:
    print("   DIFF", row[0], "msgs:", row[1], "chars:", row[2])
    for name in row[3]:
        print("        ", name)

# --- coverage vs the saved list --------------------------------------------------
list_payload = json.load(open(glob.glob(os.path.join(NEW_DIR, "*list*.json"))[0]))
expected = {i["id"].lower(): i for i in list_payload["items"]}
expected_ids = set(expected)
exported_ids = {k for k in new_by_id if k != "NO-ID"}
missing = expected_ids - exported_ids
extra = exported_ids - expected_ids
print(f"\nlist JSON: {len(expected_ids)} conversations "
      f"(archived {list_payload['counts']['archived']}, active {list_payload['counts']['active']})")
print(f"exported unique ids: {len(exported_ids)}")
print(f"in list but not exported: {len(missing)}")
print(f"exported but not in list: {len(extra)}")
if extra:
    print("   extra:", sorted(extra)[:10])

# --- archive flag fidelity -------------------------------------------------------
flag_mismatch = []
for cid, item in expected.items():
    files = new_by_id.get(cid, [])
    if not files:
        continue
    listed_archived = bool(item.get("archivedAt"))
    txt_archived = any(f["archived"] for f in files)
    if listed_archived != txt_archived:
        flag_mismatch.append((cid, item.get("type"), listed_archived, txt_archived))
print(f"archive-flag mismatches between list JSON and TXT headers: {len(flag_mismatch)}")
for row in flag_mismatch[:10]:
    print("   ", row)

# --- old vs new on the shared conversations --------------------------------------
common = sorted(set(old_by_id) & set(new_by_id) - {"NO-ID"})
print(f"\nconversations present in both old and new exports: {len(common)}")
worse, better, equal = [], [], 0
for cid in common:
    o = old_by_id[cid][0]
    n = max(new_by_id[cid], key=lambda x: (x["messages"] or 0, x["chars"]))
    delta_msg = (n["messages"] or 0) - (o["messages"] or 0)
    delta_chars = n["chars"] - o["chars"]
    tool_delta = {k: n["tools"][k] - o["tools"][k] for k in set(o["tools"]) | set(n["tools"])
                  if n["tools"][k] != o["tools"][k]}
    if delta_msg < 0 or delta_chars < -2000:
        worse.append((cid, o, n, delta_msg, delta_chars, tool_delta))
    elif delta_msg > 0 or delta_chars > 2000 or tool_delta:
        better.append((cid, o, n, delta_msg, delta_chars, tool_delta))
    else:
        equal += 1
print(f"  unchanged: {equal}; richer now: {len(better)}; poorer now: {len(worse)}")
for cid, o, n, dm, dc, td in better[:10]:
    print(f"   RICHER {cid[:8]} msgs {o['messages']}->{n['messages']} chars {o['chars']}->{n['chars']} tool delta {td}")
for cid, o, n, dm, dc, td in worse[:10]:
    print(f"   POORER {cid[:8]} msgs {o['messages']}->{n['messages']} chars {o['chars']}->{n['chars']} tool delta {td}")

# --- aggregate quality indicators -------------------------------------------------
def aggregate(items, label):
    tools = Counter()
    notices = Counter()
    for i in items:
        tools.update(i["tools"])
        notices.update(i["notices"])
    total_chars = sum(i["chars"] for i in items)
    print(f"\n[{label}] files={len(items)} chars={total_chars:,} "
          f"empty_markers={sum(i['empty_markers'] for i in items)}")
    for k, v in sorted(tools.items()):
        print(f"    tool {k}: {v}")
    for k, v in sorted(notices.items()):
        print(f"    notice {k}: {v}")

aggregate([i for i in new_items if i["type"] == "agentic"], "new / agentic")
old_agentic = [i for i in old_items if i["type"] == "agentic"]
aggregate(old_agentic, "old / agentic")

# per-conversation tool totals for the shared set (old vs new)
print("\nshared-set tool totals:")
for label, mapping in (("old", old_by_id), ("new", new_by_id)):
    tools = Counter()
    for cid in common:
        for f in mapping[cid]:
            tools.update(f["tools"])
    print(f"  {label}: {dict(tools)}")
