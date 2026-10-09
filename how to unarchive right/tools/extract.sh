#!/usr/bin/env bash
# Universal extractor for Arena sandboxes. Usage: tools/extract.sh <archive> [outdir]
# Handles .zip (python stdlib), .rar incl. multi-volume .partN.rar (7zz -> node-unrar-js fallback), .7z/.tar.* (7zz).
# Only needs hosts that are allowed in the sandbox: registry.npmjs.org.
set -euo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8          # Cyrillic filenames
A="$(realpath "$1")"; OUT="$(realpath -m "${2:-/tmp/extracted}")"; mkdir -p "$OUT"
TOOLS=/tmp/arena-extract-tools              # outside repo -> never committed
# For multi-volume archives always start from part1
case "$A" in *.part[0-9]*.rar) A="$(ls "${A%.part*}".part*1.rar | head -1)";; esac

get_7zz() {
  if command -v 7zz >/dev/null; then command -v 7zz; return; fi
  local b="$TOOLS/7z/node_modules/7zip-bin-full/linux/x64/7zz"
  if [ ! -x "$b" ]; then
    mkdir -p "$TOOLS/7z" && (cd "$TOOLS/7z" && npm init -y >/dev/null && npm i -s 7zip-bin-full >/dev/null)
    chmod +x "$b"                            # npm ships it without the +x bit
  fi
  echo "$b"
}
unrar_js() {
  [ -d "$TOOLS/unrar/node_modules/node-unrar-js" ] || { mkdir -p "$TOOLS/unrar" && (cd "$TOOLS/unrar" && npm init -y >/dev/null && npm i -s node-unrar-js >/dev/null); }
  (cd "$TOOLS/unrar" && node --input-type=module -e "
    import {createExtractorFromFile} from 'node-unrar-js';
    const ex = await createExtractorFromFile({filepath: process.argv[1], targetPath: process.argv[2]});
    let n=0; for (const f of ex.extract().files) n++; console.log('extracted entries:', n);" "$A" "$OUT")
}

case "${A,,}" in
  *.zip) python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); print('extracted entries:', len(z.namelist()))" "$A" "$OUT" ;;
  *.rar) { Z=$(get_7zz) && "$Z" x -y -o"$OUT" "$A" >/dev/null && echo "extracted with 7zz"; } || unrar_js ;;
  *)     Z=$(get_7zz); "$Z" x -y -o"$OUT" "$A" >/dev/null && echo "extracted with 7zz" ;;
esac
echo "files: $(find "$OUT" -type f | wc -l) -> $OUT"
# Nested archives? report them (don't auto-recurse)
find "$OUT" -type f \( -iname '*.rar' -o -iname '*.zip' -o -iname '*.7z' \) -printf 'nested archive: %p\n' | head
