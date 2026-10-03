#!/usr/bin/env node
// Build (or verify) a userscript from src/exporter.template.js.
//
//   node tools/build-version.mjs                  # build the template's version
//   node tools/build-version.mjs --version 2.4.1  # build a bumped version
//   node tools/build-version.mjs --check          # fail if the shipped file is stale
//   node tools/build-version.mjs --out /tmp/x.js  # write somewhere else
//
// What it does:
//   1. reads the template and injects the fflate UMD bundle (node_modules/fflate)
//      in place of the `/* __FFLATE_UMD__ */` marker, so the userscript stays
//      self-contained and the archive step needs no CDN;
//   2. optionally rewrites "@version";
//   3. verifies the result parses (`node --check`) and reports size + sha256.
//
// `--check` is used by CI: it rebuilds in memory and compares with the file
// committed in the repository, so a template edit without a rebuilt userscript
// fails the build instead of silently shipping the old script.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "src", "exporter.template.js");
const MARKER = "      /* __FFLATE_UMD__ */";
const FFLATE = path.join(ROOT, "node_modules", "fflate", "umd", "index.js");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}
const has = (name) => process.argv.includes(`--${name}`);

if (!fs.existsSync(TEMPLATE)) {
  console.error(`template not found: ${path.relative(ROOT, TEMPLATE)}`);
  process.exit(2);
}
if (!fs.existsSync(FFLATE)) {
  console.error(`fflate not found: ${path.relative(ROOT, FFLATE)} — run "npm install" first`);
  process.exit(2);
}

const template = fs.readFileSync(TEMPLATE, "utf8");
if (!template.includes(MARKER)) {
  console.error(`no fflate marker in the template (expected a line: ${MARKER.trim()})`);
  process.exit(2);
}
const fflateSource = fs.readFileSync(FFLATE, "utf8").trim();
const indented = fflateSource
  .split("\n")
  .map((line) => (line.trim() ? `      ${line}` : ""))
  .join("\n");

const templateVersion = (template.match(/@version\s+(\S+)/) || [])[1];
if (!templateVersion) {
  console.error("the template has no @version line");
  process.exit(2);
}
const version = arg("version") || templateVersion;

// NB: a replacement *function* is required here — the minified fflate body
// contains "$&"-style sequences that String.replace would expand.
let output = template.replace(MARKER, () => indented);
if (version !== templateVersion) {
  output = output.replace(`// @version      ${templateVersion}`, () => `// @version      ${version}`);
  console.log(`version bumped: ${templateVersion} -> ${version} (add a changelog line for it!)`);
}

const defaultName = `Arena.ai - LMSYS Arena Chat Exporter-${version}.user.js`;
const outPath = path.resolve(arg("out") || path.join(ROOT, defaultName));
const sha = crypto.createHash("sha256").update(output).digest("hex");

// Syntax check the produced script exactly as a browser/engine would parse it.
const probe = path.join(ROOT, "node_modules", ".build-probe.js");
fs.writeFileSync(probe, output);
try {
  execFileSync(process.execPath, ["--check", probe], { stdio: "pipe" });
} catch (error) {
  console.error("generated script does not parse:");
  console.error(String(error.stderr || error.message).trim());
  fs.rmSync(probe, { force: true });
  process.exit(1);
}
fs.rmSync(probe, { force: true });

if (has("check")) {
  if (!fs.existsSync(outPath)) {
    console.error(`MISSING  ${path.relative(ROOT, outPath)} (build it with: node tools/build-version.mjs)`);
    process.exit(1);
  }
  const current = fs.readFileSync(outPath, "utf8");
  const currentSha = crypto.createHash("sha256").update(current).digest("hex");
  if (currentSha !== sha) {
    console.error(
      `STALE    ${path.relative(ROOT, outPath)}\n` +
        `         on disk:  ${currentSha}\n` +
        `         expected: ${sha}\n` +
        `         rebuild:  node tools/build-version.mjs`
    );
    process.exit(1);
  }
  console.log(`OK       ${path.relative(ROOT, outPath)} matches the template (v${version}, ${output.length} B)`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, output);
console.log(`built    ${path.relative(ROOT, outPath)}`);
console.log(`         version ${version}, ${output.length} chars (${Buffer.byteLength(output)} bytes)`);
console.log(`         fflate ${fflateSource.length} chars inlined from node_modules/fflate`);
console.log(`         sha256  ${sha}`);
