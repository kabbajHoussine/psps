/**
 * Tests for tools/validate-catalog.mjs.
 *
 *   npm test
 *
 * Each case writes a small catalog to a temp file, runs the validator on it and
 * asserts the exit code and the reported message. The validator's own view of
 * images/ is the repo's, so a posterUrl that must "exist" uses a real filename
 * read from images/ at run time.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = join(ROOT, "tools", "validate-catalog.mjs");
const IMAGES = join(ROOT, "images");

/** A real images/ filename, so "file exists" checks can pass. */
const REAL_IMAGE = readdirSync(IMAGES).find((f) => !f.startsWith("."));
const POSTER_URL = `https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/${REAL_IMAGE}`;

const workdir = mkdtempSync(join(tmpdir(), "validate-catalog-"));

/** Run the validator on the given documents; returns {status, output}. */
function run(docs) {
  const files = Object.entries(docs).map(([name, value]) => {
    const path = join(workdir, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return path;
  });
  const result = spawnSync(process.execPath, [VALIDATOR, ...files], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A valid package; override any field to break it. */
function pkg(overrides = {}) {
  return {
    titleId: "PPSA01234",
    title: "A Game",
    version: "01.000.000",
    sizeBytes: 1073741824,
    posterUrl: POSTER_URL,
    downloadLinks: [{ name: "Viki", url: "https://vikingfile.com/f/abc" }],
    ...overrides,
  };
}

function catalog(packages) {
  return { name: "GFS Catalog-fpkg", packages };
}

test("accepts a valid catalog", () => {
  const { status, output } = run({ "good.json": catalog([pkg(), pkg({ titleId: "PPSA05678" })]) });
  assert.equal(status, 0, output);
  assert.match(output, /All 1 catalog file valid/);
});

test("rejects a file that is not valid JSON", () => {
  const { status, output } = run({ "broken.json": "{ this is not json" });
  assert.equal(status, 1);
  assert.match(output, /is not valid JSON/);
});

test("rejects a missing required field", () => {
  const broken = pkg();
  delete broken.sizeBytes;
  const { status, output } = run({ "missing.json": catalog([broken]) });
  assert.equal(status, 1);
  assert.match(output, /missing required field "sizeBytes"/);
  assert.match(output, /packages\[0\] PPSA01234/);
});

test("rejects a non-positive or non-integer sizeBytes", () => {
  for (const sizeBytes of ["1073741824", 0, -1, 1.5, null]) {
    const { status, output } = run({ "size.json": catalog([pkg({ sizeBytes })]) });
    assert.equal(status, 1, `sizeBytes=${JSON.stringify(sizeBytes)} should fail`);
    assert.match(output, /sizeBytes must be a positive integer/);
  }
});

test("rejects a malformed titleId", () => {
  for (const titleId of ["PSA01234", "PPSA1234", "PPSA123456", "PPSA1234X", "ppsa01234"]) {
    const { status, output } = run({ "id.json": catalog([pkg({ titleId })]) });
    assert.equal(status, 1, `titleId=${titleId} should fail`);
    assert.match(output, /must be PPSA followed by 5 digits/);
  }
});

test("rejects a duplicate titleId and points at the first one", () => {
  const { status, output } = run({
    "dupe.json": catalog([pkg(), pkg({ titleId: "PPSA01234", title: "Another Game" })]),
  });
  assert.equal(status, 1);
  assert.match(output, /duplicate titleId "PPSA01234"/);
  assert.match(output, /first seen at packages\[0\]/);
});

test("rejects empty or missing downloadLinks", () => {
  const empty = run({ "empty.json": catalog([pkg({ downloadLinks: [] })]) });
  assert.equal(empty.status, 1);
  assert.match(empty.output, /downloadLinks must not be empty/);

  const missing = pkg();
  delete missing.downloadLinks;
  const absent = run({ "absent.json": catalog([missing]) });
  assert.equal(absent.status, 1);
  assert.match(absent.output, /missing required field "downloadLinks"/);
});

test("rejects a non-https download link", () => {
  const { status, output } = run({
    "link.json": catalog([pkg({ downloadLinks: [{ name: "Viki", url: "http://vikingfile.com/f/abc" }] })]),
  });
  assert.equal(status, 1);
  assert.match(output, /must be https/);
});

test("rejects a link without a name", () => {
  const { status, output } = run({
    "linkname.json": catalog([pkg({ downloadLinks: [{ name: "", url: "https://x.example/f" }] })]),
  });
  assert.equal(status, 1);
  assert.match(output, /downloadLinks\[0\] name must be a non-empty string/);
});

test("rejects a posterUrl that is not a repo raw link", () => {
  const { status, output } = run({
    "poster.json": catalog([pkg({ posterUrl: "https://dlpsgame.com/wp-content/uploads/2026/09/17-wsc.jpg" })]),
  });
  assert.equal(status, 1);
  assert.match(output, /must be https:\/\/raw\.githubusercontent\.com\/kabbajHoussine\/psps/);
});

test("rejects a posterUrl whose image file is missing", () => {
  const { status, output } = run({
    "ghost.json": catalog([
      pkg({
        posterUrl:
          "https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/no-such-file-here.png",
      }),
    ]),
  });
  assert.equal(status, 1);
  assert.match(output, /images\/no-such-file-here\.png, which is missing or not a file/);
});

test("rejects a posterUrl that escapes images/ with . or ..", () => {
  for (const file of ["..", "."]) {
    const { status, output } = run({
      "escape.json": catalog([
        pkg({
          posterUrl: `https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/${file}`,
        }),
      ]),
    });
    assert.equal(status, 1, `images/${file} should be rejected`);
    assert.match(output, /must be https:\/\/raw\.githubusercontent\.com\/kabbajHoussine\/psps/);
  }
});

test("rejects a posterUrl pointing at a directory rather than a file", () => {
  const { status, output } = run({
    "dir.json": catalog([
      pkg({
        posterUrl:
          "https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/schemas",
      }),
    ]),
  });
  assert.equal(status, 1);
  assert.match(output, /is missing or not a file/);
});

test("rejects an unexpected field, keeping the schema closed", () => {
  const { status, output } = run({ "extra.json": catalog([pkg({ sha256: "deadbeef" })]) });
  assert.equal(status, 1);
  assert.match(output, /unexpected field "sha256"/);
});

test("rejects a catalog whose packages is empty or not an array", () => {
  const empty = run({ "nopkgs.json": catalog([]) });
  assert.equal(empty.status, 1);
  assert.match(empty.output, /packages must not be empty/);

  const notArray = run({ "notarray.json": { name: "x", packages: {} } });
  assert.equal(notArray.status, 1);
  assert.match(notArray.output, /packages must be an array/);
});

test("reads an injected broken entry in a copy of the real fpkg.json", async () => {
  const { readFileSync } = await import("node:fs");
  const real = JSON.parse(readFileSync(join(ROOT, "fpkg.json"), "utf8"));
  const injected = structuredClone(real);
  injected.packages.push(pkg({ titleId: "PPSA99999", sizeBytes: -5, posterUrl: "https://example.com/x.jpg" }));

  const { status, output } = run({ "injected.json": injected });
  assert.equal(status, 1, "a deliberately broken entry must fail the run");
  assert.match(output, /packages\[\d+\] PPSA99999/);
  assert.match(output, /sizeBytes must be a positive integer/);
  assert.match(output, /must be https:\/\/raw\.githubusercontent\.com/);
});

test("the shipped catalogs validate as a whole", () => {
  const result = spawnSync(process.execPath, [VALIDATOR], { encoding: "utf8", cwd: ROOT });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /fpkg\.json/);
  assert.match(result.stdout, /lz4\.json/);
  assert.match(result.stdout, /All 2 catalog files valid/);
});
