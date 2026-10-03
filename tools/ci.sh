#!/usr/bin/env bash
# Local CI: everything the GitHub Actions workflow does, without GitHub.
#   bash tools/ci.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== every userscript parses =="
for file in *Exporter-*.user.js; do
  node --check "$file"
  echo "   ok  $file"
done

echo "== committed userscript matches src/exporter.template.js =="
node tools/build-version.mjs --check

echo "== tests: newest exporter =="
node tests/exporter.test.mjs | tail -2

echo "== tests: shipped 2.3.2 fallback =="
node tests/exporter.test.mjs "Arena.ai - LMSYS Arena Chat Exporter-2.3.2.user.js" | tail -2

echo "== audit tool compiles =="
python3 -m py_compile tools/audit_export.py
echo "   ok  tools/audit_export.py"

echo
echo "all checks passed"
