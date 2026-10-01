# psps

A PlayStation 5 game package catalog, published as two static JSON files
consumed by an external app. There is no application code and no build step —
the repo is data plus the poster images it points at.

| Path | What it is |
| --- | --- |
| `fpkg.json` | The `.fpkg` catalog — 229 packages |
| `lz4.json` | The `.lz4` catalog — 20 packages |
| `images/` | 230 poster images, referenced by each package's `posterUrl` |
| `docs/upstream-export.md` | How the upstream export was reverse-engineered |
| `tools/fetch-export.sh` | Fetch + pretty-print the upstream export |
| `tools/export-via-ui.mjs` | Fallback: drive the site's own export button |
| `samples/fpkg.export.json` | A point-in-time capture of the upstream export |

Both catalogs are copies of the **GFS Catalog** site
(<https://pfs-library.xetdy-am.workers.dev/>), with `posterUrl` rewritten to a
local `images/` path. Only that one field differs from upstream.

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
| `version` | string | Verbatim from upstream — padding is inconsistent (`"1.08"`, `"01.000.010"`) |
| `sizeBytes` | integer | Bytes, not GB or MB |
| `posterUrl` | string | `raw.githubusercontent.com` link into `images/` — see below |
| `downloadLinks` | array | `{ "name": string, "url": string }`, in upstream order |

Two rules the JSON itself does not enforce:

- **`titleId` is not unique.** The upstream export ships duplicates (the same id
  for different games), and `fpkg.json` has inherited several. Do not key
  entries by `titleId` alone.
- **`posterUrl` must resolve.** Every `posterUrl` points at

  ```
  https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/<filename>
  ```

  and `<filename>` **must exist in `images/`**. Never commit a `posterUrl` whose
  file is missing — the app has no fallback. Most filenames are opaque
  (`f7d7f07d…b3.jpg`, `01Slmbo3uyEiyiomq7TxBBLl.png`); `.jpg` and `.png` both occur.

### Formatting

- 2-space indent, one package object per entry, `downloadLinks` expanded one
  field per line.
- Key order fixed: `titleId` → `title` → `version` → `sizeBytes` → `posterUrl` →
  `downloadLinks`.
- File ends with a trailing newline.

## Adding an entry by hand

1. Append the package object to `packages` in `fpkg.json`, following the key
   order and 2-space indent above.
2. Drop the poster into `images/` under a filename that is not already taken
   (keep the upstream name if there is one), then set `posterUrl` to the
   `raw.githubusercontent.com/…/images/<filename>` link for it.
3. Confirm the file really is in `images/` and that the JSON still parses:

   ```bash
   python3 -m json.tool fpkg.json > /dev/null && echo "parses"
   ls images/<filename>
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
`tools/fetch-export.sh`, which adds an HTTP status check and a JSON parse
check, and applies the repo's exact formatting:

```bash
tools/fetch-export.sh fpkg /tmp/fpkg.export.json
```

`docs/upstream-export.md` has the full recon: why the endpoint is byte-identical
to the button, the endpoint reference, and the failure modes (a Cloudflare
Turnstile gate on the UI, content-hashed asset names, and that `/api/export` is
undocumented and may drift). `tools/export-via-ui.mjs` drives the real browser as
a ground-truth fallback.

The sync itself — diffing the export against `fpkg.json`, merging new/removed/
changed packages and downloading posters — is tracked in **issue #4**
(<https://github.com/kabbajHoussine/psps/issues/4>). Until it lands, the refresh
is manual: fetch the export, diff it against `fpkg.json`, merge by hand, and
mirror any new posters into `images/`.

## Gotchas

- `sizeBytes` changes constantly and is large (`20401094656`, not `20.4 GB`) —
  store it as an integer.
- `posterUrl` is the **only** field this repo rewrites relative to upstream.
  Anything else diverging from the export is drift.
- Link `name` labels (`Viki - 4.xx+`, `Akirabox pt.2`, `… - DLC`) are *derived*
  by the site from metadata the export does not carry. Copy them out of the
  export; do not try to recompute them.
