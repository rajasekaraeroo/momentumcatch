import fs from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";
import type { DecodedFeedResponse } from "./normalize";

/**
 * Runtime loader for MarketDataFeedV3.proto (SPEC §12.5). The proto file is
 * NOT committed by the build agent — it must be downloaded from the Upstox
 * developer docs (scripts/fetch-proto.sh) because the file is the contract
 * and must never be reconstructed from memory (packages/shared/proto/README.md).
 */

export const PROTO_RELATIVE_PATH = "packages/shared/proto/MarketDataFeedV3.proto";

export interface FeedDecoder {
  decode(buf: Buffer): DecodedFeedResponse;
}

function findMessageType(ns: protobuf.NamespaceBase, name: string): protobuf.Type | null {
  for (const nested of ns.nestedArray) {
    if (nested instanceof protobuf.Type && nested.name === name) return nested;
    if (nested instanceof protobuf.Namespace) {
      const found = findMessageType(nested, name);
      if (found) return found;
    }
  }
  return null;
}

export async function loadFeedDecoder(repoRoot: string): Promise<FeedDecoder> {
  const protoPath = path.join(repoRoot, PROTO_RELATIVE_PATH);
  if (!fs.existsSync(protoPath)) {
    throw new Error(
      `${PROTO_RELATIVE_PATH} not found. Download it from the Upstox developer ` +
        `docs (Market Data Feed V3) — run scripts/fetch-proto.sh on a machine ` +
        `with access to assets.upstox.com, then restart the engine.`,
    );
  }
  const root = await protobuf.load(protoPath);
  // Locate FeedResponse by name rather than hard-coding the package path,
  // so a namespace change in the published proto doesn't break loading.
  const feedResponse = findMessageType(root, "FeedResponse");
  if (!feedResponse) {
    throw new Error(
      `No message named FeedResponse found in ${PROTO_RELATIVE_PATH} — the ` +
        `downloaded proto does not look like MarketDataFeedV3.`,
    );
  }
  return {
    decode(buf: Buffer): DecodedFeedResponse {
      const msg = feedResponse.decode(buf);
      return feedResponse.toObject(msg, {
        longs: Number,
        enums: String,
        defaults: false,
      }) as DecodedFeedResponse;
    },
  };
}
