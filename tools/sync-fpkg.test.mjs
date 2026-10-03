/**
 * Tests for tools/sync-fpkg.mjs.
 *
 *   npm test
 *
 * The scheduled workflow (.github/workflows/sync-fpkg.yml) trusts this script to
 * be all-or-nothing: when any package cannot be mirrored, fpkg.json must be left
 * exactly as it was, so the workflow can never commit a half-updated catalog.
 * These cases pin that behaviour, and the idempotence the schedule relies on to
 * exit cleanly when the upstream export has not moved.
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
const certDir = mkdtempSync(join(tmpdir(), "sync-fpkg-cert-"));
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

const exportOf = (packages) => ({ name: "GFS Catalog-fpkg", packages });

/** A scratch repo: the tools, schemas and package.json, plus one mirrored poster. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "sync-fpkg-"));
  for (const entry of ["tools", "schemas"]) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  copyFileSync(join(ROOT, "package.json"), join(dir, "package.json"));
  mkdirSync(join(dir, "images"));
  writeFileSync(join(dir, "images", MIRRORED_FILE), PNG);
  return dir;
}

function writeCatalog(dir, packages) {
  writeFileSync(join(dir, "fpkg.json"), `${JSON.stringify({ name: "GFS Catalog-fpkg", packages }, null, 2)}\n`);
}

const readText = (dir) => readFileSync(join(dir, "fpkg.json"), "utf8");
const readCatalog = (dir) => JSON.parse(readText(dir));

/** Run the sync as a child process, so the staging server stays reachable. */
function sync(dir, exportDoc, env = {}) {
  const exportPath = join(dir, "export.json");
  writeFileSync(exportPath, JSON.stringify(exportDoc, null, 2));
  // Run the scratch COPY of the script, not the original: both resolve the repo
  // root from their own location, so the copy reads and writes inside `dir`.
  const script = join(dir, "tools", "sync-fpkg.mjs");
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, exportPath], { cwd: dir, env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (status) => resolvePromise({ status, output }));
  });
}

/** Run the repo's real validator — the scratch copy, so images/ is the scratch one. */
function validate(dir) {
  const r = spawnSync(process.execPath, [join(dir, "tools", "validate-catalog.mjs"), "fpkg.json"], {
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

test("is idempotent: syncing the same export twice changes nothing", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg()]);
  const before = readText(dir);
  const { status, output } = await sync(dir, exportOf([pkg()]));
  assert.equal(status, 0, output);
  assert.equal(readText(dir), before);
});

test("leaves fpkg.json untouched when a poster cannot be downloaded", async () => {
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

test("refuses a non-https posterUrl without touching fpkg.json", async () => {
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

test("fails on an export that is not a non-empty catalog", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg()]);
  const before = readText(dir);
  for (const bad of [exportOf([]), { name: "x" }, []]) {
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

test("reports added, removed and updated entries", async () => {
  const dir = scratch();
  writeCatalog(dir, [pkg(), pkg({ titleId: "PPSA05678", title: "Going Away" })]);
  const { status, output } = await sync(
    dir,
    exportOf([pkg({ version: "02.000.000" }), pkg({ titleId: "PPSA07777", title: "Brand New" })]),
  );
  assert.equal(status, 0, output);
  assert.match(output, /added \(1\)/);
  assert.match(output, /PPSA07777 \/ Brand New/);
  assert.match(output, /removed \(1\)/);
  assert.match(output, /PPSA05678 \/ Going Away/);
  assert.match(output, /updated \(same titleId and title, other fields changed\) \(1\)/);
});

test("downloads a missing poster, rewrites posterUrl, and the result validates", { skip: !staging }, async () => {
  const dir = scratch();
  writeCatalog(dir, []);
  const { status, output } = await sync(
    dir,
    exportOf([pkg({ posterUrl: stagingUrl("/fresh.png") })]),
    // The staging server is self-signed; the child alone relaxes verification.
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
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
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
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
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  );
  assert.equal(status, 1, output);
  assert.match(output, /refusing non-image response/);
  assert.equal(readText(dir), before);
});
