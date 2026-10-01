#!/usr/bin/env bash
#
# Fetch the upstream GFS Catalog export for a given pack.
#
# This is the reproducible form of the site's header menu:
#     Tools -> Export JSON -> <pack>
#
# The page's own export handler calls GET /api/export?pack=<pack> and re-serialises
# the response with JSON.stringify(obj, null, 2). Calling the endpoint directly and
# pretty-printing the same way reproduces the downloaded file byte for byte.
#
# Usage:
#     tools/fetch-export.sh [pack] [output]
#     tools/fetch-export.sh fpkg > /tmp/fpkg.json
#
# pack   : fpkg (default) | lz4 | pfs | packizard
# output : file to write; defaults to stdout.
#
# NOTE: this only fetches. It does not touch fpkg.json or images/.

set -euo pipefail

PACK="${1:-fpkg}"
OUT="${2:-}"
BASE="${GFS_BASE_URL:-https://pfs-library.xetdy-am.workers.dev}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Fail loudly on HTTP errors instead of writing an error body to the output file.
code="$(curl -sS -o "$tmp" -w '%{http_code}' "$BASE/api/export?pack=$PACK")"
if [ "$code" != "200" ]; then
  echo "fetch-export: GET /api/export?pack=$PACK -> HTTP $code" >&2
  echo "               body: $(head -c 200 "$tmp")" >&2
  exit 1
fi

# Validate before emitting anything, so a truncated/HTML response never lands in the repo.
if command -v python3 >/dev/null 2>&1; then
  python3 -m json.tool --indent 2 --no-ensure-ascii "$tmp"
else
  cat "$tmp"
fi > "${OUT:-/dev/stdout}"
