import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PUBLIC_KEY,
  verifySignedRuntimeFeed,
} from "./runtime-feed-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(repoRoot, process.argv[2] ?? "v2/runtime/stable/runtime-release-feed.signed.json");
const channel = process.argv[3] ?? "stable";
const publicKey = process.env.MSTY_NEXUS_RUNTIME_RELEASE_FEED_PUBLIC_KEY ?? DEFAULT_PUBLIC_KEY;
const envelope = verifySignedRuntimeFeed(await readFile(path, "utf8"), publicKey, channel);
console.log(`ok: ${channel} feed with ${envelope.feed.releases.length} runtime releases`);
