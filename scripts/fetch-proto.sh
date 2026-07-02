#!/usr/bin/env bash
# Downloads MarketDataFeedV3.proto from the Upstox developer assets into
# packages/shared/proto/ (see that folder's README — the proto file is the
# contract and is never hand-written from memory).
#
# Run this on a machine with access to assets.upstox.com. If the URL 404s,
# find the current link on the Upstox docs "Market Data Feed V3" page.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeedV3.proto"
DEST="packages/shared/proto/MarketDataFeedV3.proto"

curl -fSsL "$URL" -o "$DEST"
head -1 "$DEST" | grep -q 'syntax' || {
  echo "Downloaded file does not look like a .proto — verify $URL against the docs." >&2
  exit 1
}
echo "Wrote $DEST"
