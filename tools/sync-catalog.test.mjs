/**
 * Tests for tools/sync-catalog.mjs.
 *
 *   npm test
 *
 * The scheduled workflow (.github/workflows/sync-catalog.yml) trusts this script
 * to be all-or-nothing: when any package cannot be mirrored, the catalog must be
 * left exactly as it was, so the workflow can never commit a half-updated
 * catalog. These cases pin that behaviour, and the idempotence the schedule
 * relies on to exit cleanly when the upstream export has not moved.
 *
 * The script is pack-parameterised: the pack argument selects which catalog file
 * is written, so most cases run against `fpkg` and a few pin that `lz4` writes
 * lz4.json and touches nothing else.
 *
 * Each case runs the real script — as a child process, exactly how the workflow
 * runs it — against a throwaway copy of the repo (a scratch directory holding
 * fpkg.json, images/ and the tools). The poster-download cases point at a local
 * HTTPS server started here, so nothing reaches the network and the suite stays
 * deterministic; when openssl is unavailable those cases are skipped rather than
 * made flaky.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PREFIX = "https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/";

/** A poster the scratch repo already mirrors, so reuse needs no network. */
const MIRRORED_FILE = "mirrored.png";
const MIRRORED_POSTER = PREFIX + MIRRORED_FILE;

/** Eight bytes of PNG magic — enough for the download body checks. */
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** An https URL the script will try to fetch; it must never be reachable. */
const UNREACHABLE = "https://poster.invalid/nope.png";

/* ------------------------------------------------------------------ staging */

/**
 * A tiny HTTPS server that stands in for the upstream poster host, with two
 * routes: a real PNG and a 500. Skipped (null) when openssl is not present.
 */
const certDir = mkdtempSync(join(tmpdir(), "sync-catalog-cert-"));
const keyFile = join(certDir, "key.pem");
const certFile = join(certDir, "cert.pem");
const OPENSSL = ["/usr/bin/openssl", "/opt/homebrew/bin/openssl", "openssl"].find((bin) => {
  const r = spawnSync(bin, ["version"], { stdio: "ignore" });
  return r.status === 0;
});

let staging = null;
const stagingUrl = (path) => `${staging?.base}${path}`;

if (OPENSSL) {
  const gen = spawnSync(OPENSSL, [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", keyFile, "-out", certFile,
    "-days", "3650", "-nodes", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  if (gen.status === 0) {
    const server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
      if (req.url === "/fresh.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
      } else if (req.url === "/boom.png") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("nope");
      } else if (req.url === "/not-an-image.png") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>login</html>");
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1");
    await new Promise((ready) => server.once("listening", ready));
    const { port } = server.address();
    staging = { server, base: `https://localhost:${port}` };
    after(() => server.close());
  }
}

/* ----------------------------------------------------------------- fixtures */

/** One package in the repo's exact shape, already pointing at a mirrored poster. */
function pkg(overrides = {}) {
  return {
    titleId: "PPSA01234",
    title: "A Game",
    version: "01.000.000",
    sizeBytes: 1073741824,
    posterUrl: MIRRORED_POSTER,
    downloadLinks: [{ name: "Viki", url: "https://vikingfile.com/f/abc" }],
    ...overrides,
  };
}

const exportOf = (packages, pack = "fpkg") => ({ name: `GFS Catalog-${pack}`, packages });

/** A scratch repo: the tools, schemas and package.json, plus one mirrored poster. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "sync-catalog-"));
  for (const entry of ["tools", "schemas"]) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  copyFileSync(join(ROOT, "package.json"), join(dir, "package.json"));
  mkdirSync(join(dir, "images"));
  writeFileSync(join(dir, "images", MIRRORED_FILE), PNG);
  return dir;
}

function writeCatalog(dir, packages, pack = "fpkg") {
  writeFileSync(join(dir, `${pack}.json`), `${JSON.stringify({ name: `GFS Catalog-${pack}`, packages }, null, 2)}\n`);
}

const readText = (dir, pack = "fpkg") => readFileSync(join(dir, `${pack}.json`), "utf8");
const readCatalog = (dir, pack = "fpkg") => JSON.parse(readText(dir, pack));

/** Run the sync as a child process, so the staging server stays reachable. */
function sync(dir, exportDoc, { pack = "fpkg", env = {} } = {}) {
  const exportPath = join(dir, `${pack}.export.json`);
  writeFileSync(exportPath, JSON.stringify(exportDoc, null, 2));
  // Run the scratch COPY of the script, not the original: both resolve the repo
  // root from their own location, so the copy reads and writes inside `dir`.
  const script = join(dir, "tools", "sync-catalog.mjs");
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, pack, exportPath], { cwd: dir, env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (status) => resolvePromise({ status, output }));
  });
}

/** Run the repo's real validator — the scratch copy, so images/ is the scratch one. */
function validate(dir, pack = "fpkg") {
  const r = spawnSync(process.execPath, [join(dir, "tools", "validate-catalog.mjs"), `${pack}.json`], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/* -------------------------------------------------------------------- tests */

test("mirrors an export and reuses an already-mirrored poster", async () => {
  const dir = scratch();
  writeCatalog(dir, []);
  const { status, output } = await sync(dir, exportOf([pkg()]));
  assert.equal(status, 0, output);
  assert.match(output, /wrote fpkg\.json: 1 packages/);
  assert.match(output, /images downloaded: 0/);
  assert.equal(readCatalog(dir).packages[0].posterUrl, MIRRORED_POSTER);
});

test("keeps the house style: key order, 2-space indent, trailing newline", async () => {
  const dir = scratch();
  writeCatalog(dir, []);
  await sync(dir, exportOf([pkg()]));
  const text = readText(dir);
  assert.ok(text.endsWith("}\n"), "must end with a newline");
  assert.match(text, /^\{\n  "name": "GFS Catalog-fpkg",\n  "packages": \[\n    \{\n      "titleId"/);
  assert.deepEqual(Object.keys(readCatalog(dir).packages[0]), [
    "titleId", "title", "version", "sizeBytes", "posterUrl", "downloadLinks",
  ]);
});

test("lz4 writes lz4.json in the same style and leaves fpkg.json alone", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg()]); // an existing fpkg catalog, which must not move
  const fpkgBefore = readText(dir);
  const { status, output } = await sync(dir, exportOf([pkg({ titleId: "PPSA05813", title: "The Quarry" })], "lz4"), {
    pack: "lz4",
  });
  assert.equal(status, 0, output);
  assert.match(output, /wrote lz4\.json: 1 packages/);

  const text = readText(dir, "lz4");
  assert.match(text, /^\{\n  "name": "GFS Catalog-lz4",\n  "packages": \[\n    \{\n      "titleId"/);
  assert.deepEqual(Object.keys(readCatalog(dir, "lz4").packages[0]), [
    "titleId", "title", "version", "sizeBytes", "posterUrl", "downloadLinks",
  ]);
  assert.equal(readText(dir), fpkgBefore, "fpkg.json must be untouched by an lz4 sync");

  const check = validate(dir, "lz4");
  assert.equal(check.status, 0, check.output);
});

test("refuses an export whose name does not match the pack", async () => {
  // The pack argument selects the file; an fpkg export synced as lz4 would
  // otherwise write the wrong data into lz4.json and validate fine.
  const dir = scratch();
  writeCatalog(dir, [], "lz4");
  const before = readText(dir, "lz4");
  const { status, output } = await sync(dir, exportOf([pkg()], "fpkg"), { pack: "lz4" });
  assert.equal(status, 1);
  assert.match(output, /is not a "lz4" export/);
  assert.equal(readText(dir, "lz4"), before);
});

test("is idempotent: syncing the same export twice changes nothing", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg()]);
  const before = readText(dir);
  const { status, output } = await sync(dir, exportOf([pkg()]));
  assert.equal(status, 0, output);
  assert.equal(readText(dir), before);
});

test("leaves the catalog untouched when a poster cannot be downloaded", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg()]);
  const before = readText(dir);
  const { status, output } = await sync(
    dir,
    exportOf([pkg({ titleId: "PPSA09999", title: "No Poster", posterUrl: UNREACHABLE })]),
  );
  assert.equal(status, 1, "an unresolvable poster must fail the run");
  assert.match(output, /could not be mirrored/);
  assert.match(output, /fpkg\.json was NOT modified/);
  assert.equal(readText(dir), before, "fpkg.json must be byte-identical");
});

test("refuses a non-https posterUrl without touching the catalog", async () => {
  // Start empty, so there is no already-mirrored poster to reuse: the bad URL
  // must then be inspected rather than skipped.
  const dir = scratch();
  writeCatalog(dir, []);
  const before = readText(dir);
  const { status, output } = await sync(dir, exportOf([pkg({ posterUrl: "http://insecure.example/x.png" })]));
  assert.equal(status, 1);
  assert.match(output, /bad posterUrl/);
  assert.equal(readText(dir), before);
});

test("refuses a malformed titleId and leaves the catalog untouched", async () => {
  // Upstream ships a malformed id (PPSA0724) for one fpkg title. Importing it
  // would put a bad id into a validated catalog, so the run must stop instead.
  const dir = scratch();
  writeCatalog(dir, [pkg()]);
  const before = readText(dir);
  const { status, output } = await sync(dir, exportOf([pkg({ titleId: "PPSA0724", title: "Bad Id" })]));
  assert.equal(status, 1);
  assert.match(output, /malformed titleId "PPSA0724"/);
  assert.match(output, /fpkg\.json was NOT modified/);
  assert.equal(readText(dir), before);
});

test("fails on an export that is not a non-empty catalog", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg()]);
  const before = readText(dir);
  for (const bad of [exportOf([]), { name: "GFS Catalog-fpkg" }, []]) {
    const { status, output } = await sync(dir, bad);
    assert.equal(status, 1, `export ${JSON.stringify(bad)} should be rejected`);
    assert.match(output, /non-empty "packages" array/);
  }
  assert.equal(readText(dir), before);
});

test("fails when an upstream package is missing a required field", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg()]);
  const broken = pkg();
  delete broken.sizeBytes;
  const { status, output } = await sync(dir, exportOf([broken]));
  assert.equal(status, 1);
  assert.match(output, /missing "sizeBytes"/);
});

test("reports added, removed and updated entries with the changed values", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg(), pkg({ titleId: "PPSA05678", title: "Going Away" })]);
  const { status, output } = await sync(
    dir,
    exportOf([pkg({ version: "02.000.000" }), pkg({ titleId: "PPSA07777", title: "Brand New" })]),
  );
  assert.equal(status, 0, output);
  assert.match(output, /added \(1\)/);
  assert.match(output, /PPSA07777 \/ Brand New/);
  assert.match(output, /removed \(present locally, absent upstream\) \(1\)/);
  assert.match(output, /PPSA05678 \/ Going Away/);
  assert.match(output, /updated \(same titleId and title, other fields changed\) \(1\)/);
  assert.match(output, /version 01\.000\.000 -> 02\.000\.000/);
});

test("reports a download link that was relabelled but kept its url", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg({ downloadLinks: [{ name: "Viki", url: "https://vikingfile.com/f/abc" }] })]);
  const { status, output } = await sync(
    dir,
    exportOf([pkg({ downloadLinks: [{ name: "Viki - 9.xx+", url: "https://vikingfile.com/f/abc" }] })]),
  );
  assert.equal(status, 0, output);
  assert.match(output, /relabelled download links \(url kept, label changed\) \(1\)/);
  assert.match(output, /"Viki" -> "Viki - 9\.xx\+"/);
  // A relabel is not a lost url, so it must not be reported as dropped.
  assert.doesNotMatch(output, /dropped download links/);
});

test("reports a download link whose url disappeared", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg({ downloadLinks: [{ name: "Viki", url: "https://vikingfile.com/f/gone" }] })]);
  const { status, output } = await sync(
    dir,
    exportOf([pkg({ downloadLinks: [{ name: "Viki - 9.xx+", url: "https://vikingfile.com/f/still" }] })]),
  );
  assert.equal(status, 0, output);
  assert.match(output, /dropped download links \(url present before, absent upstream\) \(1\)/);
  assert.match(output, /Viki <https:\/\/vikingfile\.com\/f\/gone>/);
});

test("reports duplicate titleIds as mirrored, not resolved", async () => {
  const dir = scratch();
  writeCatalog(dir, []);
  const { status, output } = await sync(
    dir,
    exportOf([
      pkg({ titleId: "PPSA28420", title: "NBA 2K26" }),
      pkg({ titleId: "PPSA28420", title: "Suicide Squad Kill The Justice League" }),
    ]),
  );
  assert.equal(status, 0, output);
  assert.match(output, /duplicate titleIds upstream \(mirrored as-is\) \(1\)/);
  assert.match(output, /PPSA28420 x2/);
  assert.equal(readCatalog(dir).packages.length, 2, "both rows are mirrored verbatim");
});

test("downloads a missing poster, rewrites posterUrl, and the result validates", { skip: !staging }, async () => {
  const dir = scratch();
  writeCatalog(dir, []);
  const { status, output } = await sync(
    dir,
    exportOf([pkg({ posterUrl: stagingUrl("/fresh.png") })]),
    // The staging server is self-signed; the child alone relaxes verification.
    { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
  );
  assert.equal(status, 0, output);
  assert.match(output, /images downloaded: 1/);
  assert.equal(readCatalog(dir).packages[0].posterUrl, PREFIX + "fresh.png");
  assert.deepEqual(readFileSync(join(dir, "images", "fresh.png")), PNG);

  const check = validate(dir);
  assert.equal(check.status, 0, check.output);
  assert.match(check.output, /All 1 catalog file valid/);
});

test("rolls back images fetched earlier in a run that later fails", { skip: !staging }, async () => {
  const dir = scratch();
  writeCatalog(dir, []);
  const before = readText(dir);
  const { status, output } = await sync(
    dir,
    exportOf([
      pkg({ titleId: "PPSA01111", title: "Fetchable", posterUrl: stagingUrl("/fresh.png") }),
      pkg({ titleId: "PPSA02222", title: "Broken", posterUrl: stagingUrl("/boom.png") }),
    ]),
    { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
  );
  assert.equal(status, 1, output);
  assert.match(output, /removed 1 image\(s\) fetched this run/);
  assert.equal(readText(dir), before);
  assert.equal(existsSync(join(dir, "images", "fresh.png")), false, "the fetched image must be rolled back");
});

test("rejects an HTML response, so a login page never becomes a poster", { skip: !staging }, async () => {
  const dir = scratch();
  writeCatalog(dir, []);
  const before = readText(dir);
  const { status, output } = await sync(
    dir,
    exportOf([pkg({ posterUrl: stagingUrl("/not-an-image.png") })]),
    { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
  );
  assert.equal(status, 1, output);
  assert.match(output, /refusing non-image response/);
  assert.equal(readText(dir), before);
});
