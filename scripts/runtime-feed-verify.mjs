import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PUBLIC_KEY,
  parseFeedVersion,
  verifySignedRuntimeFeed,
} from "./runtime-feed-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(repoRoot, process.argv[2] ?? "v2/runtime/stable/runtime-release-feed.signed.json");
const channel = process.argv[3] ?? "stable";
// Third argument: 2 (default) allows only the runtimes of the frozen v2 feed,
// 3 also allows the runtimes that only v3 may list.
const feedVersion = parseFeedVersion(process.argv[4] ?? "2");
const publicKey = process.env.MSTY_NEXUS_RUNTIME_RELEASE_FEED_PUBLIC_KEY ?? DEFAULT_PUBLIC_KEY;
const envelope = verifySignedRuntimeFeed(await readFile(path, "utf8"), publicKey, channel, { feedVersion });
console.log(`ok: v${feedVersion} ${channel} feed with ${envelope.feed.releases.length} runtime releases`);
