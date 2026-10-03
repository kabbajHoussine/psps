#!/usr/bin/env node
/**
 * Sync fpkg.json from an upstream GFS Catalog export.
 *
 *   tools/fetch-export.sh fpkg /tmp/fpkg.export.json
 *   node tools/sync-fpkg.mjs /tmp/fpkg.export.json
 *
 * The input is the export described in docs/upstream-export.md, i.e. exactly
 * what the site's Tools -> Export JSON -> FPKG produces. This script:
 *
 *   1. mirrors every package in the export, in upstream order, keeping the six
 *      house-style fields and their order;
 *   2. rewrites posterUrl to the repo's own images/ raw link, downloading any
 *      poster that is not mirrored yet (existing images are never re-fetched);
 *   3. writes fpkg.json as 2-space-indented JSON with a trailing newline;
 *   4. refuses to finish if any posterUrl would name a file missing from images/.
 *
 * It is intentionally dependency-free (Node's standard library only, Node 18+
 * for global fetch) and idempotent: running it twice downloads nothing the
 * second time.
 *
 * ## Poster filenames
 *
 * The repo names a mirrored poster after the last path segment of the upstream
 * URL (e.g. .../2503/d975a2a2...e76.png -> d975a2a2...e76.png). When a package
 * already has a mirrored poster whose file still exists, that file is kept as
 * is, so hand-picked names such as PPSA20955_poster.jpg survive a sync.
 *
 * ## What it does not do
 *
 * Upstream's export ships duplicate titleIds (see tools/known-issues.json).
 * The script mirrors them faithfully rather than inventing ids: resolving them
 * means correcting data the source itself mis-files, which is a curation
 * decision, not a sync one. It reports them so they stay visible.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGES_DIR = join(ROOT, "images");
const CATALOG = join(ROOT, "fpkg.json");

/** The repo's poster link prefix; the validator pins this exact shape. */
const POSTER_PREFIX =
  "https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/";
const POSTER_RE = /^https:\/\/raw\.githubusercontent\.com\/kabbajHoussine\/psps\/[^\s]+\/images\/([^/]+)$/;

const FIELDS = ["titleId", "title", "version", "sizeBytes", "posterUrl", "downloadLinks"];

/**
 * Identity of an entry for reporting purposes. titleId alone is not enough —
 * upstream lists the same titleId more than once — so title is included and
 * counts are compared as a multiset. A version bump keeps the same identity and
 * shows up as an update, while a rename shows as one added and one removed.
 */
const identity = (p) => `${p.titleId}\u0000${p.title}`;

function fail(message) {
  console.error(`sync-fpkg: ${message}`);
  process.exit(1);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Last path segment of a poster URL, ignoring any query string. */
function posterFilename(url) {
  const { pathname } = new URL(url);
  const name = basename(pathname);
  // A URL whose path ends in a slash (or is just a host) has no usable name;
  // fall back to the whole URL so we never write into a directory.
  return name && name !== "/" ? name : basename(new URL(url).hostname);
}

/** Reduce one upstream package to the repo's six fields, in order. */
function toEntry(pkg, posterUrl) {
  return {
    titleId: pkg.titleId,
    title: pkg.title,
    version: pkg.version,
    sizeBytes: pkg.sizeBytes,
    posterUrl,
    downloadLinks: pkg.downloadLinks.map(({ name, url }) => ({ name, url })),
  };
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (type.startsWith("text/") || type.includes("html")) {
    throw new Error(`refusing non-image response (${type})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("empty body");
  writeFileSync(dest, bytes);
  return bytes.length;
}

/**
 * Index the existing catalog so mirrored posters can be reused.
 * Returns titleId -> queue of entries, so duplicates map in order.
 */
function indexExisting(packages) {
  const byId = new Map();
  for (const pkg of packages) {
    if (!byId.has(pkg.titleId)) byId.set(pkg.titleId, []);
    byId.get(pkg.titleId).push(pkg);
  }
  return byId;
}

/** Take the queued existing entry that best matches an upstream package. */
function takeExisting(queue, pkg) {
  if (!queue || queue.length === 0) return undefined;
  const exact = queue.findIndex((e) => e.title === pkg.title && e.version === pkg.version);
  const byTitle = exact === -1 ? queue.findIndex((e) => e.title === pkg.title) : exact;
  const index = byTitle === -1 ? 0 : byTitle;
  return queue.splice(index, 1)[0];
}

/** A local posterUrl we can safely reuse: right prefix, and the file is there. */
function reusablePoster(entry) {
  if (!entry || typeof entry.posterUrl !== "string") return undefined;
  const match = POSTER_RE.exec(entry.posterUrl);
  if (!match || !isFile(join(IMAGES_DIR, match[1]))) return undefined;
  return entry.posterUrl;
}

async function main(argv) {
  const exportPath = argv.find((a) => !a.startsWith("-"));
  if (!exportPath) fail("usage: tools/sync-fpkg.mjs <export.json>  (see docs/upstream-export.md)");
  if (!existsSync(exportPath)) fail(`no such export file: ${exportPath}`);

  const exportDoc = JSON.parse(readFileSync(exportPath, "utf8"));
  if (!Array.isArray(exportDoc?.packages) || exportDoc.packages.length === 0) {
    fail(`${exportPath}: expected an object with a non-empty "packages" array`);
  }

  const previous = existsSync(CATALOG)
    ? JSON.parse(readFileSync(CATALOG, "utf8")).packages ?? []
    : [];
  const existingById = indexExisting(previous);

  mkdirSync(IMAGES_DIR, { recursive: true });

  const entries = [];
  const downloaded = [];
  const reused = [];
  const unresolved = [];
  const duplicates = new Map();

  for (const pkg of exportDoc.packages) {
    for (const field of FIELDS) {
      if (field !== "posterUrl" && pkg[field] === undefined) {
        fail(`upstream package ${pkg.titleId} is missing "${field}"`);
      }
    }

    duplicates.set(pkg.titleId, (duplicates.get(pkg.titleId) ?? 0) + 1);

    const prior = takeExisting(existingById.get(pkg.titleId), pkg);
    let posterUrl = reusablePoster(prior);

    if (posterUrl) {
      reused.push(pkg.titleId);
    } else {
      const upstreamUrl = pkg.posterUrl;
      if (typeof upstreamUrl !== "string" || !/^https:\/\//.test(upstreamUrl)) {
        unresolved.push({ titleId: pkg.titleId, title: pkg.title, reason: `bad posterUrl ${upstreamUrl}` });
        continue;
      }
      const filename = posterFilename(upstreamUrl);
      const dest = join(IMAGES_DIR, filename);
      if (!isFile(dest)) {
        try {
          await download(upstreamUrl, dest);
          downloaded.push(filename);
        } catch (err) {
          unresolved.push({ titleId: pkg.titleId, title: pkg.title, url: upstreamUrl, reason: err.message });
          continue;
        }
      }
      posterUrl = POSTER_PREFIX + filename;
    }

    entries.push(toEntry(pkg, posterUrl));
  }

  // A catalog that points at a missing image must never be written.
  for (const entry of entries) {
    const match = POSTER_RE.exec(entry.posterUrl);
    if (!match || !isFile(join(IMAGES_DIR, match[1]))) {
      fail(`refusing to write: ${entry.titleId} posterUrl names a missing file`);
    }
  }

  const doc = { name: exportDoc.name, packages: entries };
  writeFileSync(CATALOG, `${JSON.stringify(doc, null, 2)}\n`);

  // ± report. Compared as multisets of (titleId, title, version): a titleId can
  // legitimately repeat, so counts matter and a map would collapse them.
  const count = (list, key) => {
    const map = new Map();
    for (const item of list) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
    return map;
  };
  const before = count(previous, identity);
  const after = count(entries, identity);
  const label = (k) => k.split("\u0000").join(" / ");

  const added = [];
  const removed = [];
  for (const [k, n] of after) {
    for (let i = n - (before.get(k) ?? 0); i > 0; i--) added.push(label(k));
  }
  for (const [k, n] of before) {
    for (let i = n - (after.get(k) ?? 0); i > 0; i--) removed.push(label(k));
  }

  // An entry carried over unchanged by identity may still have changed fields;
  // compare the retained ones pairwise, in order.
  const previousByIdentity = new Map();
  for (const p of previous) {
    const k = identity(p);
    if (!previousByIdentity.has(k)) previousByIdentity.set(k, []);
    previousByIdentity.get(k).push(p);
  }
  const changed = [];
  for (const entry of entries) {
    const queue = previousByIdentity.get(identity(entry));
    const prior = queue?.shift();
    if (!prior) continue;
    if (
      prior.version !== entry.version ||
      prior.sizeBytes !== entry.sizeBytes ||
      prior.posterUrl !== entry.posterUrl ||
      JSON.stringify(prior.downloadLinks) !== JSON.stringify(entry.downloadLinks)
    ) {
      changed.push(`${entry.titleId} / ${entry.title}`);
    }
  }

  // Upstream owns the link list, but a mirror the repo added by hand and the
  // export no longer carries would otherwise disappear without a trace. Group by
  // titleId rather than by title so a renamed entry (e.g. "Marvels Wolverine" ->
  // "Marvel's Wolverine") is still compared. URLs are matched, not labels:
  // relabelling ("Viki" -> "Viki - 4.xx+") is a normal part of a sync, losing a
  // url is not.
  const mergeByTitleId = (list) => {
    const map = new Map();
    for (const p of list) {
      if (!map.has(p.titleId)) map.set(p.titleId, []);
      map.get(p.titleId).push(p);
    }
    return map;
  };
  const previousById = mergeByTitleId(previous);
  const afterById = mergeByTitleId(entries);
  const droppedLinks = [];
  for (const [titleId, afterList] of afterById) {
    const beforeList = previousById.get(titleId);
    if (!beforeList) continue;
    const kept = new Set(afterList.flatMap((p) => p.downloadLinks.map((l) => l.url)));
    const gone = [];
    for (const prior of beforeList) {
      for (const link of prior.downloadLinks) {
        // A url can appear twice under one titleId with different labels, or on
        // two titles that share it; report each url once.
        if (!kept.has(link.url) && !gone.some((g) => g.url === link.url)) {
          gone.push({ title: prior.title, name: link.name, url: link.url });
        }
      }
    }
    for (const g of gone) {
      droppedLinks.push(`${titleId} / ${g.title}: ${g.name} <${g.url}>`);
    }
  }

  const dupes = [...duplicates].filter(([, n]) => n > 1);

  const show = (title, list) => {
    if (list.length === 0) return;
    console.log(`\n${title} (${list.length}):`);
    for (const item of list) console.log(`  - ${typeof item === "string" ? item : JSON.stringify(item)}`);
  };

  console.log(`wrote fpkg.json: ${entries.length} packages (upstream had ${exportDoc.packages.length})`);
  console.log(`images downloaded: ${downloaded.length}, posters reused: ${reused.length}`);
  show("added", added);
  show("removed", removed);
  show("updated (same titleId and title, other fields changed)", changed);
  show("dropped download links (url present before, absent upstream)", droppedLinks);
  show("duplicate titleIds upstream (mirrored as-is)", dupes.map(([id, n]) => `${id} x${n}`));
  show("downloaded images", downloaded);
  show("UNRESOLVED", unresolved);

  if (unresolved.length > 0) {
    console.log(`\n${unresolved.length} package(s) could not be resolved; fpkg.json was written without them.`);
    return 1;
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
