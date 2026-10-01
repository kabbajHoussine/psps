# psps

PS5 game package download catalog. Two static JSON data files plus the poster
images they point at — no application code and no build step.

| Path | What it is |
| --- | --- |
| `fpkg.json` | The `.fpkg` catalog |
| `lz4.json` | The `.lz4` catalog |
| `images/` | Poster images, referenced by `posterUrl` |
| `schemas/catalog.schema.json` | JSON Schema for a catalog document |
| `tools/validate-catalog.mjs` | Validator (dependency-free) |
| `tools/known-issues.json` | Pre-existing violations the validator tolerates |

Both catalogs are mirrored from the GFS Catalog site
(<https://pfs-library.xetdy-am.workers.dev/>), whose header offers
**Tools → Export JSON → fpkg**.

## Catalog format

A catalog is an object with a `name` and a `packages` array. Each package has
exactly these keys, in this order:

```json
{
  "name": "GFS Catalog-fpkg",
  "packages": [
    {
      "titleId": "PPSA28997",
      "title": "God of War Sons of Sparta Digital Deluxe Edition",
      "version": "1.08",
      "sizeBytes": 7752415969,
      "posterUrl": "https://raw.githubusercontent.com/kabbajHoussine/psps/refs/heads/main/images/d89cad73b88799601590a408edc70d6bd123113cba317710.jpg",
      "downloadLinks": [
        { "name": "Viki", "url": "https://vik1ngfile.site/f/B9n4QfFdy9" }
      ]
    }
  ]
}
```

Files are 2-space indented with a trailing newline.

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

No dependencies, so there is nothing to install; Node 18 or newer is all that is
needed.

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

The validator implements the rules in code rather than by loading the schema
file, because per-entry reporting (which line, which package, which field) needs
more than a generic pass/fail. The two agree on the current catalogs: `ajv`
reports `lz4.json` valid and `fpkg.json` invalid at exactly the one `posterUrl`
the validator grandfathered below.

### Pre-existing violations

The upstream site's own export ships duplicate `titleId`s, so a few violations
predate the validator:

```
ok    fpkg.json (229 packages, 9 known)
  ~ packages[0] PPSA03671 line 4: posterUrl "https://dlpsgame.com/..." must be ...
      known: Marvel's Wolverine still points at the upstream poster ...
```

Those are listed in `tools/known-issues.json` with a reason each. The rule is:

- a violation **not** in the baseline fails the run;
- a violation **in** the baseline is reported and passes;
- a baseline entry that no longer matches anything prints a note, so the list
  shrinks as the debt is paid off — fixing one is never punished.

Fixing them is catalog-data work, tracked separately; the baseline only stops
inherited breakage from blocking every unrelated pull request.

## CI

[`.github/workflows/validate-catalog.yml`](.github/workflows/validate-catalog.yml)
runs `npm test` on every pull request and on pushes to `main`. A PR containing an
invalid entry fails the check.
