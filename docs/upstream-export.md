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

Not acted on here — syncing is the next issue's job. Repo `fpkg.json` vs the 2026-10-01
export:

- 5 upstream entries absent from the repo, including renames that look like they may
  already be locally curated:
  `Marvel's Wolverine` (repo has "Marvels Wolverine"), `Hollow Knight: Silksong`,
  `READY OR NOT`, `Assassin's Creed Black Flag Resynced`, and
  `Crisis Core Final Fantasy VII Reunion` (repo has "Final Fantasy Vll Crisis Core Reunion").
- 2 repo entries absent upstream (the two older spellings above).
- 9 shared entries differ only in download-link labels (e.g. `Viki` → `Viki - 9.xx+`,
  `Viki - 4.xx+`), and 1 also changed size (`SAROS`).
