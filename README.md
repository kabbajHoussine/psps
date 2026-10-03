# psps

A PlayStation 5 game package catalog, published as two static JSON files
consumed by an external app. There is no application code and no build step —
the repo is data plus the poster images it points at.

| Path | What it is |
| --- | --- |
| `fpkg.json` | The `.fpkg` catalog — 228 packages |
| `lz4.json` | The `.lz4` catalog — 31 packages |
| `images/` | 236 poster images, referenced by each package's `posterUrl` |
| `samples/fpkg.export.json` | A point-in-time capture of the upstream export |
| `docs/upstream-export.md` | How the upstream export was reverse-engineered |
| `tools/fetch-export.sh` | Fetch + pretty-print the upstream export |
| `tools/sync-catalog.mjs` | Rebuild `<pack>.json` from an export, mirroring posters |
| `tools/export-via-ui.mjs` | Fallback: drive the site's own export button |
| `schemas/catalog.schema.json` | JSON Schema for a catalog document |
| `tools/validate-catalog.mjs` | Validator (dependency-free) |
| `tools/known-issues.json` | Pre-existing violations the validator tolerates |

Both catalogs are mirrored from the **GFS Catalog** site
(<https://pfs-library.xetdy-am.workers.dev/>), whose header offers
**Tools → Export JSON → fpkg**. Each package's `posterUrl` is rewritten to a
local `images/` path; that rewrite, and rebuilding a catalog from an export,
is what [`tools/sync-catalog.mjs`](#how-the-data-is-refreshed) does. A handful of
inherited data problems remain — see
[Known drift vs upstream](#known-drift-vs-upstream).

## Catalog format

A catalog is an object with a `name` and a `packages` array:

```json
{
  "name": "GFS Catalog-fpkg",
  "packages": [ /* ... */ ]
}
```

`name` is `<catalog name>-<pack>` — `"GFS Catalog-fpkg"` / `"GFS Catalog-lz4"`.

Each entry in `packages` has exactly these six keys, in this order:

```json
{
  "titleId": "PPSA32557",                        // PS5 title id
  "title": "MotoGP 26",                          // display name
  "version": "1.000",                            // kept verbatim from upstream
  "sizeBytes": 20401094656,                      // integer, bytes
  "posterUrl": "https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/f7d7f07d359ba0613bef8b43e1af74becad0e00357c1ccb3.jpg",
  "downloadLinks": [
    { "name": "Viki - 4.xx+", "url": "https://vikingfile.com/f/9IX2s9JuIj" },
    { "name": "Viki - 5.xx+", "url": "https://vikingfile.com/f/GY3JidVgce" }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `titleId` | string | `PPSA` + 5 digits, e.g. `PPSA32557` |
| `title` | string | Display name; may contain `'`, `:`, `™`, `-` |
| `version` | string | Verbatim from upstream — padding is inconsistent (`"1.08"`, `"01.000.011"`) |
| `sizeBytes` | integer | Bytes, not GB or MB |
| `posterUrl` | string | `raw.githubusercontent.com` link into `images/` — see below |
| `downloadLinks` | array | `{ "name": string, "url": string }`, in upstream order |

Two rules the JSON itself does not enforce:

- **`titleId` is not unique.** The upstream export ships duplicate ids (the same
  id for different games) and `fpkg.json` has inherited a few. Do not key entries
  by `titleId` alone. As of the last sync, four ids are duplicated
  (`PPSA28420`, `PPSA20800`, `PPSA01341`, `PPSA07274`); `tools/known-issues.json`
  lists each with a reason.
- **`posterUrl` must resolve.** Every `posterUrl` points at

  ```
  https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/<filename>
  ```

  and `<filename>` **must exist in `images/`**. Never commit a `posterUrl` whose
  file is missing — the app has no fallback. Most filenames are opaque
  (`f7d7f07d…b3.jpg`, `01Slmbo3uyEiyiomq7TxBBLl.png`); `.jpg` and `.png` both
  occur. `npm test` enforces this, so a broken link fails CI rather than shipping.

### Formatting

- 2-space indent, one package object per entry, `downloadLinks` expanded one
  field per line.
- Key order fixed: `titleId` → `title` → `version` → `sizeBytes` → `posterUrl` →
  `downloadLinks`.
- File ends with a trailing newline.

## Validating

```bash
npm test
```

That runs the validator's own test suite and then validates `fpkg.json` and
`lz4.json`. Exit code is `0` when the catalogs are valid and `1` when they are
not, with one line per offending entry naming the array index, `titleId`, JSON
line and the problem:

```
FAIL  fpkg.json (1 problem)
  - packages[229] PPSA99999 line 3697: sizeBytes must be a positive integer (got -1)
```

To validate a specific file — useful before committing a hand-edited catalog:

```bash
npm run validate                      # the default files
node tools/validate-catalog.mjs path/to/catalog.json
```

No dependencies, so there is nothing to install; Node 20 or newer is all that is
needed. (The `test` script relies on the shell expanding `tools/*.test.mjs`,
because `node --test` only learned to glob for itself in Node 22.)

### What is checked

- the file parses as JSON, and is an object with a `name` and a `packages` array;
- every package has all six required fields, with no unexpected extras;
- `sizeBytes` is a positive integer;
- `titleId` matches `PPSA` followed by exactly 5 digits;
- no duplicate `titleId` within a file;
- `downloadLinks` is non-empty, every entry has a `name` and an `https://` `url`;
- every `posterUrl` is a `raw.githubusercontent.com/kabbajHoussine/psps/...`
  link **and** the file it names exists in `images/`.

`schemas/catalog.schema.json` is the same contract in JSON Schema form, for
editors and other tooling — structure, required fields, types and the `titleId`
and `posterUrl` patterns. Two things it cannot express, and which only the
validator checks: **duplicate `titleId`s** and **whether the poster file is
really present in `images/`**.

### Pre-existing violations

The upstream site's own export ships duplicate `titleId`s, so a few violations
predate the validator. `npm test` currently reports them and still exits `0`:

```
ok    fpkg.json (228 packages, 4 known)
  ~ packages[19] PPSA28420 line 335: duplicate titleId "PPSA28420" (first seen at packages[18] line 318)
      known: Upstream lists NBA 2K26 (twice) and Suicide Squad ... (issue #4).
```

Those are listed in `tools/known-issues.json` with a reason each. The rule is:

- a violation **not** in the baseline fails the run;
- a violation **in** the baseline is reported and passes;
- a baseline entry that no longer matches anything prints a note, so the list
  shrinks as the debt is paid off — fixing one is never punished.

Fixing them is catalog-data work, tracked in issue #4; the baseline only stops
inherited breakage from blocking every unrelated pull request.

## CI

[`.github/workflows/validate-catalog.yml`](.github/workflows/validate-catalog.yml)
runs `npm test` on every pull request and on pushes to `main`. A PR containing an
invalid entry fails the check.

## Automatic sync

[`.github/workflows/sync-catalog.yml`](.github/workflows/sync-catalog.yml) runs the
refresh described under
[How the data is refreshed](#how-the-data-is-refreshed) on its own, once a day
(`17 3 * * *` UTC), and on demand via **Actions → Sync catalog → Run workflow**
(tick *dry_run* to only print the diff). A matrix runs one job per pack, so both
catalogs refresh daily. Each job:

1. fetches the export with `tools/fetch-export.sh <pack>`;
2. merges it with `tools/sync-catalog.mjs <pack>` (add/update/remove packages,
   download any poster `images/` is missing, rewrite `posterUrl`);
3. validates with `tools/validate-catalog.mjs <pack>.json`;
4. opens or updates a pull request from the `automation/<pack>-sync` branch — the
   workflow has no write access to `main` and never pushes to it.

If the merge fails — the export cannot be fetched, or a poster will not download
— the job fails and the catalog is left exactly as it was, so a broken upstream
day cannot leave a half-updated catalog behind. If the export has not changed,
the run exits cleanly without opening a pull request.

**If GitHub Actions is unavailable** (disabled for the repo, out of minutes on a
private repo, or the `schedule` trigger dropped after 60 days without activity),
nothing runs and the catalog silently goes stale. The schedule is then a manual
job: run the three commands above from a checkout, or trigger the workflow by
hand, and open the PR yourself. See
[`docs/upstream-export.md`](docs/upstream-export.md) for what to do when the
export endpoint itself is down — which it was on 2026-10-03, when the whole
upstream site answered `404 error code: 1042`.

## Adding an entry by hand

Usually you would re-run the sync instead (see
[How the data is refreshed](#how-the-data-is-refreshed)), but to add one entry
directly:

1. Append the package object to `packages` in `fpkg.json`, following the key
   order and 2-space indent above.
2. Drop the poster into `images/` under a filename that is not already taken
   (keep the upstream name if there is one), then set `posterUrl` to the
   `raw.githubusercontent.com/…/images/<filename>` link for it.
3. Validate before committing — this catches a missing poster, a duplicate id, a
   bad `sizeBytes` and a malformed `titleId` in one pass:

   ```bash
   npm test
   ```

## How the data is refreshed

The upstream site exposes an export that this repo mirrors. In the site header:

**Tools → Export JSON → fpkg** downloads `gfs-catalog-fpkg.json`.

That button does not call an export endpoint directly — it fetches
`/api/packages`, filters client-side, and re-serialises. **A direct endpoint
exists and is preferred:**

```bash
curl -sS 'https://pfs-library.xetdy-am.workers.dev/api/export?pack=fpkg'
```

`pack` is one of `fpkg`, `lz4`, `pfs`, `packizard`. The repo wraps this in
`tools/fetch-export.sh`, which adds an HTTP status check and a JSON parse check,
and applies the repo's exact formatting. Feed its output to the sync tool, whose
first argument is the pack — it selects which catalog is written, so `fpkg`
maintains `fpkg.json` and `lz4` maintains `lz4.json` through the same code path:

```bash
tools/fetch-export.sh fpkg /tmp/fpkg.export.json
node tools/sync-catalog.mjs fpkg /tmp/fpkg.export.json

tools/fetch-export.sh lz4 /tmp/lz4.export.json
node tools/sync-catalog.mjs lz4 /tmp/lz4.export.json
```

`tools/sync-catalog.mjs` mirrors every package in the export in upstream order,
rewrites `posterUrl` to the repo's `images/` link, downloads any poster not
mirrored yet (existing images are never re-fetched; `images/` is shared by both
packs), and writes `<pack>.json` as 2-space-indented JSON with a trailing
newline. It refuses an export whose `name` does not end in `-<pack>`, so the
wrong pack cannot be written into a catalog that still validates.

It is **all-or-nothing**: if a poster will not download, a `posterUrl` would
name a file missing from `images/`, or a `titleId` is not `PPSA` + 5 digits, it
deletes the images it fetched, leaves the catalog exactly as it was and exits
non-zero, so a failed sync never leaves a half-updated catalog. It is idempotent
— running it twice downloads nothing the second time.

The run's **drift report** is the point of the sync: the export is authoritative
and is mirrored verbatim, so everything the mirror did not already say is printed
rather than silently applied. That is entries added and removed (multiset of
`titleId` + `title`, so a rename shows as one of each), entries whose `version`,
`sizeBytes` or `posterUrl` changed with old → new values, download links whose
label changed under a url that stayed (`Viki` → `Viki - 9.xx+`), download links
whose url disappeared, and duplicate `titleId`s — which upstream ships and the
sync mirrors as-is rather than inventing ids to paper over.

Then check and commit:

```bash
npm test
```

`docs/upstream-export.md` has the full recon: why the endpoint is byte-identical
to the button, the endpoint reference, and the failure modes (a Cloudflare
Turnstile gate on the UI, content-hashed asset names, and that `/api/export` is
undocumented and may drift). `tools/export-via-ui.mjs` drives the real browser as
a ground-truth fallback.

### Known drift vs upstream

`fpkg.json` is not a clean copy of the upstream export, and the sync tool
deliberately does not invent data to paper over that. Two things remain:

- **Duplicate `titleId`s are mirrored faithfully,** not resolved. The source
  mis-files a few games (e.g. Valkyrie Elysium under Tales of Arise's id), and
  correcting that is a curation decision, not a sync one. The sync reports them
  and `tools/known-issues.json` records them; see issue #4.
- **A poster filename may be hand-picked.** When a package already has a mirrored
  poster whose file still exists, that file is kept as is, so names such as
  `PPSA20955_poster.jpg` survive a sync even though they are not upstream's own
  filename. The `posterUrl` link is what matters, not the name.

Both catalogs are now maintained by the same sync. `lz4.json` was brought in
line with its export by the first lz4 sync: it went from 20 to 31 packages, one
shared entry (`Peppa Pig: World Adventures`) changed size and link, and the two
posters `images/` was missing were mirrored.

Earlier `fpkg.json` drift — local renames of `Marvel's Wolverine` and `Crisis
Core Final Fantasy VII Reunion`, three upstream ids missing locally, and one
`posterUrl` left pointing at `dlpsgame.com` — was resolved by the first full
fpkg sync (<https://github.com/kabbajHoussine/psps/pull/9>).

## Gotchas

- `sizeBytes` changes constantly and is large (`20401094656`, not `20.4 GB`) —
  store it as an integer.
- `posterUrl` is the field the sync rewrites. If you hand-edit anything else,
  the next sync will overwrite it — that divergence is drift, not curation.
- Link `name` labels (`Viki - 4.xx+`, `Akirabox pt.2`, `… - DLC`) are *derived*
  by the site from metadata the export does not carry. Copy them out of the
  export; do not try to recompute them.
