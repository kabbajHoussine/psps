# Upstream fpkg export (GFS Catalog)

How to obtain the upstream catalog that this repo's `fpkg.json` is a copy of.

- Site: <https://pfs-library.xetdy-am.workers.dev/> ("GFS Catalog — PS5 Game Package Catalog", UI version 2.9.0 at time of writing)
- Recon date: 2026-10-01

## TL;DR

**A direct endpoint exists. The UI is not required.**

```bash
curl -sS 'https://pfs-library.xetdy-am.workers.dev/api/export?pack=fpkg'
```

This returns the catalog in exactly the shape the header menu produces. No auth, no
cookies, no Cloudflare challenge on this path. With `jq`:

```bash
curl -sS 'https://pfs-library.xetdy-am.workers.dev/api/export?pack=fpkg' | jq .
```

The repo wraps this in [`tools/fetch-export.sh`](../tools/fetch-export.sh), which adds an
HTTP status check, a JSON parse check, and the repo's exact formatting:

```bash
tools/fetch-export.sh fpkg /tmp/fpkg.export.json
```

## Why the endpoint is equivalent to the button

The header's **Tools → Export JSON → FPKG** does *not* hit an export endpoint. Reading the
page bundle (`/assets/index-*.js`) shows the handler for that button:

1. `fetch("/api/packages?pack=fpkg", {cache:"no-store"})` — the paginated catalog API
2. filter out hidden/unavailable packages and unusable links *client-side*
3. recompute each link **label** (`<name> - <firmware> pt.<n>`, `- DLC`) from `firmware` /
   `part` metadata present only in that response
4. `atob()` each link URL — the catalog API stores `downloadLinks[].url` **base64-encoded**
5. `JSON.stringify({name: <name>+"-fpkg", packages: [...]}, null, 2)` and save as a Blob

`GET /api/export?pack=fpkg` performs the same steps server-side and returns the finished
document, compactly encoded. Verified on 2026-10-01:

| Check | Result |
| --- | --- |
| Packages | 228 both paths, same order |
| Per-package field values | 0 differences |
| `JSON.stringify(export, null, 2)` vs UI download | **byte-identical** (sha256 `d774393c…`) |

So: prefer the endpoint; it is simpler and stable. The UI path is kept as
[`tools/export-via-ui.mjs`](../tools/export-via-ui.mjs) as a ground-truth fallback in case
the endpoint drifts from the UI.

## Endpoint reference

| | |
| --- | --- |
| URL | `/api/export` |
| Method | `GET` |
| Query | `pack` — one of `fpkg`, `lz4`, `pfs`, `packizard` |
| Auth | none |
| Content-Type | `application/json; charset=utf-8` (response is `zstd`-encoded on the wire; curl handles this) |

Observed behaviour:

- `?pack=fpkg` → `200`, `{"name":"GFS Catalog-fpkg","packages":[228]}`
- `?pack=lz4` → `200`, `{"name":"GFS Catalog-lz4","packages":[31]}`
- `?pack=<unknown>` → `404`, `{"error":"No export available for \"nope\"."}`
- `pack` omitted → `200`, defaults to `pfs`

Adjacent endpoints, for contrast:

- `GET /api/packages?pack=fpkg` — the catalog API. Returns **all** packages when `page`/
  `limit` are omitted, but it is *raw*: plain link names, base64 link URLs, and the extra
  per-package metadata. This is **not** interchangeable with the export.
- `GET /api/packages?pack=fpkg&page=1&limit=12` — same, paginated (default page size 12).

## JSON shape

Top level:

```json
{ "name": "GFS Catalog-fpkg", "packages": [ /* ... */ ] }
```

`name` is `<catalog name>-<pack>`; the catalog name is currently the literal string
`GFS Catalog`.

Each entry in `packages`, in this property order:

| Field | Type | Notes |
| --- | --- | --- |
| `titleId` | string | PS5 title id, e.g. `PPSA12544`. **Not unique** — see below |
| `title` | string | Display name, may contain `'`, `:`, `™`, `-` |
| `version` | string | Kept verbatim from upstream; mixed padding (`"1.08"`, `"01.000.010"`) |
| `sizeBytes` | integer | Bytes |
| `posterUrl` | string | Upstream absolute URL (PlayStation CDN or similar) |
| `downloadLinks` | array | `{ "name": string, "url": string }`, in upstream order |

This matches the repo's `fpkg.json` schema and key order exactly — the only difference is
that the repo rewrites `posterUrl` to a local `images/` path.

A full 228-package capture is committed as [`samples/fpkg.export.json`](../samples/fpkg.export.json).

## What the export does *not* contain

Important for the sync step:

- **No unique id.** The catalog API carries `id`, `region`, `firmware`, `apr`, `credits`,
  `description`, `updatedAt`, etc. The export drops all of it. Only the six fields above
  survive, so the export alone cannot distinguish two rows that share a `titleId`.
- **`titleId` is not unique upstream.** In the 2026-10-01 capture 228 entries hold 224
  distinct `titleId`s: `PPSA28420`, `PPSA07274`, `PPSA20800`, `PPSA01341` each appear
  twice, with different titles. Repo `fpkg.json` is worse — 229 entries, 221 distinct —
  but that is the next issue's concern, not this one's. Any sync must decide how to key
  entries; `titleId` alone is not sufficient.
- **Link URLs are decrypted.** The export's URLs are usable as-is; the `packages` API's are
  base64 and need `atob`.
- **Naming is derived, not stored.** Labels such as `Viki - 9.xx+` or `Akirabox pt.2` are
  computed by the page from metadata the export does not include.

## Fragility

1. **Cloudflare Turnstile gate on the UI.** Loading `/` in a fresh browser shows
   "Verify you're human". The site clears it by writing `localStorage["gfs-captcha-verified"]`
   (`{expiry}`, 3 h TTL). The widget does not complete in headless browsers, so a UI-driven
   export must seed that key and reload — this is what `tools/export-via-ui.mjs` does. It is a
   *client-side* gate only: `/api/export` answered `200` throughout, including while the page
   was still showing the challenge, and a bare `curl` with no cookie or `User-Agent` works.
2. **Dynamic asset names.** The page bundle is content-hashed (`/assets/index-CB9Pz2c_.js`),
   so any documentation pinning a bundle URL goes stale. The `/api/export` contract is the
   stable surface.
3. **No auth, but not necessarily a promise.** The endpoint is open today. `maintenanceMode`,
   `packsHidden` and `packsComingSoon` all exist as server-controlled flags in `/api/packages`
   (`fpkg` is currently listed in `packsHidden`) — the owner can hide or disable a pack.
4. **Undocumented and unversioned.** `/api/export` is not a published API. It could change
   shape, or the UI could stop matching it. No rate limit was hit, but no rate-limit
   behaviour was probed either; keep fetches to one per sync.
5. **Data is live.** `sizeBytes`, versions and link URLs change continuously. The sample in
   `samples/` is a point-in-time snapshot, not a fixture.

## Fallback: driving the UI

Only needed if `/api/export` is suspected stale or wrong.

```bash
npm i -D playwright && npx playwright install chromium
node tools/export-via-ui.mjs fpkg /tmp/fpkg.ui.json
```

Then compare against the API path. They should differ by nothing but the trailing
newline, which the browser download omits:

```bash
tools/fetch-export.sh fpkg /tmp/fpkg.api.json
diff -q /tmp/fpkg.api.json /tmp/fpkg.ui.json   # "differ" only on the final newline
```

Manual equivalent: open the site, clear the human-check, dismiss the "What's New" modal,
then **Tools → Export JSON → FPKG**. The browser saves `gfs-catalog-fpkg.json`
(`JSON.stringify(…, null, 2)`, so it is byte-identical to a pretty-printed API response
minus the trailing newline).

## Drift at time of writing

The fpkg part below was recorded before the first sync and has since been
resolved by it (<https://github.com/kabbajHoussine/psps/pull/9>). Repo
`fpkg.json` vs the 2026-10-01 export:

- 5 upstream entries absent from the repo, including renames that look like they may
  already be locally curated:
  `Marvel's Wolverine` (repo has "Marvels Wolverine"), `Hollow Knight: Silksong`,
  `READY OR NOT`, `Assassin's Creed Black Flag Resynced`, and
  `Crisis Core Final Fantasy VII Reunion` (repo has "Final Fantasy Vll Crisis Core Reunion").
- 2 repo entries absent upstream (the two older spellings above).
- 9 shared entries differ only in download-link labels (e.g. `Viki` → `Viki - 9.xx+`,
  `Viki - 4.xx+`), and 1 also changed size (`SAROS`).

### The lz4 sync (2026-10-03)

The lz4 export of the same capture held 31 packages against the repo's 20. The
sync added the 11 missing entries, mirrored the 2 posters `images/` was missing
(named after the last path segment of the upstream URL, same policy as fpkg),
and reused the other 29 images. One shared entry drifted:

- `Peppa Pig: World Adventures` (PPSA09806): `sizeBytes` 1954210120 → 2942052598,
  and its single link's url changed (`…/f/gTy1YGRspX` → `…/f/kWkdPp1P7e`). The
  old url is reported as a dropped download link, and the new one is kept.

Upstream's lz4 pack had no duplicate `titleId`s in this capture. Note that the
sync tool never imports a `titleId` that is not `PPSA` + 5 digits: the fpkg pack
ships one such id (`PPSA0724`, for the Valkyrie Elysium row) and the run stops
and names it rather than writing it into a validated catalog.

## The sync, and what happens when the endpoint is not there

The pieces above are wired together by
[`tools/sync-catalog.mjs`](../tools/sync-catalog.mjs) and run automatically by
[`.github/workflows/sync-catalog.yml`](../.github/workflows/sync-catalog.yml) once a day and
on `workflow_dispatch`, one job per pack. The sync tool takes the pack as its first
argument and writes `<pack>.json`, so both catalogs go through the same code path. The
whole loop is dependency-free Node, so nothing needs installing:

```bash
tools/fetch-export.sh fpkg /tmp/fpkg.export.json   # 1. the export
node tools/sync-catalog.mjs fpkg /tmp/fpkg.export.json  # 2. merge + mirror posters
node tools/validate-catalog.mjs fpkg.json          # 3. validate
git status --short                                 # 4. empty = nothing to do
```

For `lz4`, swap the pack in all four commands (`lz4.json` is the file, `automation/lz4-sync`
the branch). The tool refuses an export whose `name` does not end in `-<pack>`, so an
fpkg export cannot be written into `lz4.json`.

### The drift report

The export is authoritative and the sync mirrors it verbatim, so the report is the part
that matters: everything the mirror did not already say is printed rather than silently
applied. It names

- entries added and removed, compared as a multiset of `titleId` + `title` — so a rename
  (the `Marvels Wolverine` → `Marvel's Wolverine` kind) reads as one added and one removed
  rather than a silent rewrite;
- entries whose `version`, `sizeBytes` or `posterUrl` changed, with old → new values;
- download links relabelled while keeping their url (`Viki` → `Viki - 9.xx+`), and links
  whose url disappeared;
- duplicate `titleId`s, which are mirrored as-is and never deduped.

### The endpoint is unversioned, so plan for it to break

`/api/export` is not a published API (see *Fragility* above), and it can be **entirely
gone**. On 2026-10-03 the whole host was down — the site root as well as every `/api/*`
path returned `404` with a Cloudflare body `error code: 1042`, i.e. a host-level failure,
not a change in the export's shape:

```
$ curl -sS -o /dev/null -w '%{http_code}\n' 'https://pfs-library.xetdy-am.workers.dev/api/export?pack=fpkg'
404
$ curl -sS 'https://pfs-library.xetdy-am.workers.dev/'
error code: 1042
```

This is why the workflow's first step is `tools/fetch-export.sh`, which fails on a
non-200 with the status and a snippet of the body: a down site must fail the job loudly,
not surface later as a confusing diff. Nothing in the sync path fabricates or caches a
catalog, so when the upstream is gone the run simply fails and each catalog keeps its last
good contents until the site is back.

Because a silent stall is the real risk, the run is checked in two places: a failure
notifies the repo's watchers through the normal Actions notification, and a *stale* repo
is visible from the `Sync catalog` workflow's last-run time in the Actions tab.
There is no third-party uptime monitor — a daily endpoint with no owner to page would
not have much to page *to*.

The same failure mode covers the schedule itself: **GitHub disables a `schedule` trigger
after 60 days with no repository activity**, and a private repo can run out of Actions
minutes. Either way the job stops running and nothing announces it. Re-enable it from the
Actions tab, or fall back to the manual four commands above — the sync does not depend on
Actions to be correct, only to be automatic.

