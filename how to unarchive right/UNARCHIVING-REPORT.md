# Unarchiving in past chats: what happened and how to stop rebuilding it

Source: the 519-file export in `все чаты.part1/2.rar`. I grepped every chat for unrar/7z/unzip/rarfile and similar.

## Chats where archives were extracted

| Chat | Archive | What finally worked | Dead ends / bugs on the way |
|---|---|---|---|
| **Unarchive files in repo** | `folder.part01..13.rar` (RAR5, 13 volumes) with a nested `mobile_browsers.rar` and APKs inside | npm `7zip-bin-full` → `chmod +x` → `7zz x -aoa -o. folder.part01.rar`, then the same on the inner rar | `command -v 7z/unrar/unar/bsdtar` found nothing. Python `rarfile/py7zr/patoolib` weren't installed. `apt-get update` couldn't connect (Debian is blocked). Read the `node-unrar-js` README but didn't use it. **`7zip-bin` (7za 16.02) → "Permission denied"** (no +x bit), and after chmod **"Can not open the file as archive"** because old p7zip can't read RAR5. `npm init` failed: **"Invalid name: .tmp-7zip"** (a folder name starting with a dot isn't a valid package name). Nested archive needed a second pass. **In the next turn the extracted files were gone** (FileNotFoundError on `mobile_browsers/opera_touch_2_9_9.apk`) and the agent installed 7zip-bin-full again from scratch. |
| **look in repo. how many chat exports** | `Новая папка2.rar` + zips | Downloaded the **unrar-cffi sdist from PyPI**, ran `make` in its `unrarsrc/`, copied the binary to `/usr/local/bin/unrar`, then `unrar x -o+` | apt: `unrar-free`/`p7zip-full`/`7zip`/`unar` didn't install. `pip install` hit PEP 668, then with `--break-system-packages` `rarfile` worked but had **"Cannot find working tool"**. `unrar-cffi` wheel build failed with **`pyconfig.h: No such file`**. curl of the 7-Zip GitHub release failed with **exit 35 (SSL)** because the redirect goes to objects.githubusercontent.com, which is blocked. |
| **look in repo. i managed to export my chats** | `Новая папка.rar` (contained another .rar) | `git clone github.com/aawc/unrar` → `make` → `LC_ALL=C.UTF-8 /tmp/unrar/unrar e -y` | apt install failed. `gh release download ip7z/7zip` failed. **Cyrillic filenames got mangled until `LC_ALL=C.UTF-8` was added.** The nested rar needed a second `unrar e`. |
| **прочитай json файл (Google-Collab)** | `Collab Folder.rar` | Same unrar-cffi sdist trick: `pip download --no-binary :all: unrar-cffi` → `make` in `unrarsrc` → `unrar l` / `unrar x` for single files | apt p7zip failed. www.7-zip.org gave SSL error 35. venv + pip wheel failed (`pyconfig.h`). **On the next turn `/tmp/dl` was gone** and the work had to be repeated. |
| **look in archive. there's export of chat** | rar with chatbots `.htm` | npm `node-unrar-js` + a small `extract.mjs` | pip rarfile (no backend), apt unrar-free, `unrar-cffi` all failed first |
| **посмотри внутри канала и в моём репо** | rar + `Alpha_Bot.zip` | venv + rarfile, then `libarchive-c` | libarchive-c crashed with **`undefined symbol: archive_version_number`** (no system libarchive). `sudo apt-get install unrar-free` failed. |
| **сначала посмотри в мой другой репо** | `Desktop.rar` | Tried to get the 7-Zip binary via `gh api repos/ip7z/7zip/releases/assets/<id>` (octet-stream). Also looked at the `ollm/7zip-bin-full` repo tree. | Same probing order again: command -v → ldconfig → apt → curl 7-zip.org → GitHub raw |
| Chats with **zip** only (`прочитай тщательно…`, `how many…`) | `arena-chat-export-*.zip` | `unzip -l`, `unzip -o -q f -d dir`, `unzip -tq` for integrity, Python `zipfile` | zip never caused problems. `unzip` and `zipfile` are always there. |

This session (the export itself, 2 volumes, RAR5): `node-unrar-js` and `7zip-bin-full` both worked first try, in about 3 s.

## Patterns
1. **Every agent goes through the same ~6–10 failing probes**: `command -v` → pip rarfile → apt → curl 7-zip.org/rarlab → GitHub release download. The sandbox can only reach github.com, api.github.com, npm and PyPI. Release assets redirect to a blocked CDN, and Debian mirrors are blocked.
2. **Methods that reliably work** (fastest first):
   - npm **`7zip-bin-full`** (7-Zip 26, reads RAR5 and multi-volume). Gotchas: `chmod +x` is required, and the npm folder name must not start with `.`.
   - npm **`node-unrar-js`** (WASM, no binary, no chmod). Reads multi-volume when you pass part1.
   - Building `unrar` from source (unrar-cffi sdist or `aawc/unrar`). Works but takes about a minute and needs g++.
   - zip: Python `zipfile` or `unzip`.
3. **Recurring bugs**: old `7zip-bin` (p7zip 16.02) can't open RAR5. Missing +x bit. Cyrillic names need a UTF-8 locale. Nested archives. **Extracted files and tools in /tmp disappear between turns.** Temp tool folders showed up in `git status` (the risk of committing node_modules).

## So the AI doesn't build the method every time
Already in this repo:
- **`tools/extract.sh`**: one command for zip/rar/partN.rar/7z. Uses system 7zz → npm 7zip-bin-full (with chmod) → node-unrar-js fallback. zip goes through Python's stdlib. Sets UTF-8, picks part1 automatically, installs tools into /tmp (outside git) and lists nested archives. Tested on this repo's RAR (both paths) and on a zip.
- **`AGENTS.md`**: tells the agent to run the script and not probe apt/pip/curl.

Other options, best first:
1. **Copy `tools/extract.sh` + `AGENTS.md` into each repo** where you upload archives (or keep them in a template repo). Many agents read AGENTS.md automatically.
2. **Put one line at the start of your prompt**, so it works even without the file:
   *"For rar/7z: `mkdir -p /tmp/x7 && cd /tmp/x7 && npm init -y >/dev/null && npm i 7zip-bin-full && chmod +x node_modules/7zip-bin-full/linux/x64/7zz` then `7zz x -y -o/tmp/out file.part1.rar`. Don't try apt/pip/curl."*
3. **Upload zip, not rar, when you can**: zip extracts natively. Splitting into volumes also works in zip (7-Zip's `.zip.001`), but plain unsplit zip is easiest.
4. **Commit an extracted copy** (or text files) to a branch once, when it's within size limits. Then future chats don't need to unpack anything.
5. **Remember /tmp gets reset**: the agent should re-extract at the start of each turn instead of assuming files are still there. With the script that takes about 3 s.
