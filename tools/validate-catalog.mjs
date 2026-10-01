#!/usr/bin/env node
/**
 * Validate the catalog data files in this repo.
 *
 *   node tools/validate-catalog.mjs [catalog.json ...]
 *
 * With no arguments it checks the catalog files at the repo root (fpkg.json,
 * lz4.json). Exits 0 when everything is valid, 1 when anything is not,
 * printing one itemised line per offending entry.
 *
 * Dependency-free on purpose: this runs on every pull request and must not need
 * an install step. `schemas/catalog.schema.json` is the written-down schema;
 * this script implements it in code so the checks can report per-entry detail
 * (which line, which package, which field) that a generic JSON Schema runner
 * cannot.
 *
 * ## Pre-existing problems
 *
 * The catalog is mirrored from an upstream site whose own export ships
 * duplicate `titleId`s, so a handful of violations predate this script. Those
 * are listed, with reasons, in `tools/known-issues.json`. The rule is:
 *
 *   - a violation that is NOT in the baseline  -> error, exit 1
 *   - a violation that IS in the baseline      -> reported, exit 0
 *   - a baseline entry with nothing behind it  -> reported, exit 0
 *
 * So CI gates on *new* breakage while the inherited debt is visible rather than
 * hidden, and fixing that debt is never punished — it just shows up as a
 * baseline entry that can be deleted.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGES_DIR = join(ROOT, "images");
const BASELINE_FILE = join(ROOT, "tools", "known-issues.json");

/** Matches the house style: PPSA + 5 digits. */
const TITLE_ID_RE = /^PPSA[0-9]{5}$/;

/**
 * posterUrl must be one of ours, and the trailing path segment names the
 * mirrored file in images/. The filename is excluded from being "." or "..",
 * which would otherwise let the path escape images/ while still "existing".
 */
const POSTER_URL_RE =
  /^https:\/\/raw\.githubusercontent\.com\/kabbajHoussine\/psps\/[^\s]+\/images\/(?<file>(?!\.\.?$)[^/]+)$/;

const PACKAGE_FIELDS = [
  "titleId",
  "title",
  "version",
  "sizeBytes",
  "posterUrl",
  "downloadLinks",
];

/** True when the path is an existing regular file (not a directory). */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Line numbers of each package object, so errors are clickable. */
function packageLines(text) {
  const lines = text.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    // Each package object opens with `{` followed by its `"titleId"` key.
    if (/^\s*\{\s*$/.test(lines[i]) && /"titleId"/.test(lines[i + 1] ?? "")) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Validate one parsed catalog document.
 * @returns {{check: string, titleId: string, message: string}[]} violations.
 */
function validateDocument(doc, lines) {
  const errors = [];
  const root = (check, message) => errors.push({ check, titleId: "", message: `root: ${message}` });

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    root("root", "catalog must be a JSON object");
    return errors;
  }
  if (typeof doc.name !== "string" || doc.name.trim() === "") {
    root("name", `name must be a non-empty string (got ${JSON.stringify(doc.name)})`);
  }
  for (const field of Object.keys(doc)) {
    if (field !== "name" && field !== "packages") root("field-unexpected", `unexpected field "${field}"`);
  }
  if (!Array.isArray(doc.packages)) {
    root("packages", "packages must be an array");
    return errors;
  }
  if (doc.packages.length === 0) {
    root("packages", "packages must not be empty");
  }

  const seen = new Map(); // titleId -> first index

  doc.packages.forEach((pkg, index) => {
    const id = typeof pkg?.titleId === "string" ? pkg.titleId : "(no titleId)";
    const at = (check, message) => {
      const line = lines[index] ? ` line ${lines[index]}` : "";
      errors.push({ check, titleId: id, message: `packages[${index}] ${id}${line}: ${message}` });
    };

    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
      at("package", "must be an object");
      return;
    }

    for (const field of PACKAGE_FIELDS) {
      if (!Object.hasOwn(pkg, field)) at("field-missing", `missing required field "${field}"`);
    }
    for (const field of Object.keys(pkg)) {
      if (!PACKAGE_FIELDS.includes(field)) at("field-unexpected", `unexpected field "${field}"`);
    }

    const { titleId, title, version, sizeBytes, posterUrl, downloadLinks } = pkg;

    if (Object.hasOwn(pkg, "titleId")) {
      if (typeof titleId !== "string") {
        at("titleId-format", `titleId must be a string (got ${typeof titleId})`);
      } else if (!TITLE_ID_RE.test(titleId)) {
        at("titleId-format", `titleId "${titleId}" must be PPSA followed by 5 digits`);
      } else if (seen.has(titleId)) {
        at(
          "duplicate-titleId",
          `duplicate titleId "${titleId}" (first seen at packages[${seen.get(titleId)}] line ${lines[seen.get(titleId)] ?? "?"})`,
        );
      } else {
        seen.set(titleId, index);
      }
    }

    if (Object.hasOwn(pkg, "title") && (typeof title !== "string" || title.trim() === "")) {
      at("title", "title must be a non-empty string");
    }
    if (Object.hasOwn(pkg, "version") && (typeof version !== "string" || version.trim() === "")) {
      at("version", "version must be a non-empty string");
    }

    if (Object.hasOwn(pkg, "sizeBytes")) {
      if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
        at("sizeBytes", `sizeBytes must be a positive integer (got ${JSON.stringify(sizeBytes)})`);
      }
    }

    if (Object.hasOwn(pkg, "posterUrl")) {
      if (typeof posterUrl !== "string") {
        at("posterUrl", "posterUrl must be a string");
      } else {
        const match = POSTER_URL_RE.exec(posterUrl);
        if (!match) {
          at(
            "posterUrl",
            `posterUrl "${posterUrl}" must be https://raw.githubusercontent.com/kabbajHoussine/psps/.../images/<file>`,
          );
        } else if (!isFile(join(IMAGES_DIR, match.groups.file))) {
          at(
            "posterUrl-missing-file",
            `posterUrl references images/${match.groups.file}, which is missing or not a file`,
          );
        }
      }
    }

    if (Object.hasOwn(pkg, "downloadLinks")) {
      if (!Array.isArray(downloadLinks)) {
        at("downloadLinks", "downloadLinks must be an array");
      } else if (downloadLinks.length === 0) {
        at("downloadLinks", "downloadLinks must not be empty");
      } else {
        downloadLinks.forEach((link, linkIndex) => {
          const which = `downloadLinks[${linkIndex}]`;
          if (link === null || typeof link !== "object" || Array.isArray(link)) {
            at("link", `${which} must be an object with "name" and "url"`);
            return;
          }
          for (const field of Object.keys(link)) {
            if (field !== "name" && field !== "url") {
              at("link", `${which} has unexpected field "${field}"`);
            }
          }
          if (typeof link.name !== "string" || link.name.trim() === "") {
            at("link", `${which} name must be a non-empty string`);
          }
          if (typeof link.url !== "string") {
            at("link", `${which} url must be a string`);
          } else if (!link.url.startsWith("https://")) {
            at("link", `${which} url "${link.url}" must be https`);
          }
        });
      }
    }
  });

  return errors;
}

function validateFile(file) {
  // Display repo-relative when the file is ours, otherwise the path as given.
  const rel = relative(ROOT, file);
  const shown = rel && !rel.startsWith("..") ? rel : file;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { shown, count: 0, violations: [{ check: "parse", titleId: "", message: `${shown}: ${err.message}` }] };
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {
      shown,
      count: 0,
      violations: [{ check: "parse", titleId: "", message: `${shown} is not valid JSON: ${err.message}` }],
    };
  }

  const count = Array.isArray(doc?.packages) ? doc.packages.length : 0;
  return { shown, count, violations: validateDocument(doc, packageLines(text)) };
}

function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return [];
  const parsed = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  return Array.isArray(parsed?.allowed) ? parsed.allowed : [];
}

/** Catalog documents at the repo root, in a stable order. */
function defaultTargets() {
  return readdirSync(ROOT)
    .filter((name) => /^[^/]*\.json$/.test(name) && name !== "package.json")
    .filter((name) => /(?:^|[-_])(?:fpkg|lz4|catalog)\.json$/.test(name))
    .sort()
    .map((name) => join(ROOT, name));
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith("-"));
  const targets = (args.length > 0 ? args.map((a) => resolve(a)) : defaultTargets()).filter(
    // schemas/ holds other JSON; it is not a catalog.
    (file) => !file.startsWith(join(ROOT, "schemas")),
  );

  if (targets.length === 0) {
    console.error("validate-catalog: no catalog files found to validate");
    return 1;
  }

  const baseline = loadBaseline();
  const results = targets.map(validateFile);

  // How many baselined violations of each (file, check, titleId) we tolerate.
  const allowed = new Map();
  for (const entry of baseline) {
    const key = `${entry.file}\u0000${entry.check}\u0000${entry.titleId}`;
    allowed.set(key, { ...entry, remaining: entry.count ?? 1 });
  }

  const fresh = [];
  const known = [];

  for (const { shown, violations } of results) {
    for (const violation of violations) {
      const entry = allowed.get(`${shown}\u0000${violation.check}\u0000${violation.titleId}`);
      if (entry && entry.remaining > 0) {
        entry.remaining -= 1;
        known.push({ shown, violation, reason: entry.reason });
      } else {
        fresh.push({ shown, violation });
      }
    }
  }

  // Only nudge about baseline entries for files we actually looked at; running
  // the validator on one file must not complain about the others.
  const checked = new Set(results.map((r) => r.shown));
  const stale = [...allowed.values()].filter((e) => e.remaining > 0 && checked.has(e.file));

  for (const { shown, count, violations } of results) {
    const freshHere = fresh.filter((f) => f.shown === shown);
    const knownHere = known.filter((k) => k.shown === shown);
    if (freshHere.length === 0 && knownHere.length === 0) {
      console.log(`ok    ${shown} (${count} packages)`);
    } else if (freshHere.length === 0) {
      console.log(`ok    ${shown} (${count} packages, ${knownHere.length} known)`);
    } else {
      console.log(`FAIL  ${shown} (${freshHere.length} problem${freshHere.length === 1 ? "" : "s"})`);
    }
    for (const { violation } of freshHere) console.log(`  - ${violation.message}`);
    for (const { violation, reason } of knownHere) {
      console.log(`  ~ ${violation.message}`);
      if (reason) console.log(`      known: ${reason}`);
    }
  }

  if (known.length > 0) {
    console.log(
      `\n${known.length} known problem${known.length === 1 ? "" : "s"} grandfathered by tools/known-issues.json.`,
    );
  }
  for (const entry of stale) {
    console.log(
      `note: tools/known-issues.json still lists ${entry.count} x ${entry.check} on ${entry.file} "${entry.titleId}", but nothing matches it any more — please delete that entry.`,
    );
  }

  if (fresh.length > 0) {
    console.log(
      `\n${fresh.length} problem${fresh.length === 1 ? "" : "s"} in ${new Set(fresh.map((f) => f.shown)).size} of ${results.length} file${results.length === 1 ? "" : "s"}`,
    );
    return 1;
  }

  console.log(`\nAll ${results.length} catalog file${results.length === 1 ? "" : "s"} valid.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
