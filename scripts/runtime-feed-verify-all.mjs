import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FEED_VERSIONS, verifySignedRuntimeFeed } from "./runtime-feed-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Each feed version is checked against its own runtime allowlist, so a runtime
// that only v3 may list fails here if it reaches v2. A version directory that
// does not exist yet (v3 before its first refresh) is skipped.
let checked = 0;
for (const feedVersion of FEED_VERSIONS) {
  const root = resolve(repoRoot, `v${feedVersion}/runtime`);
  let channels;
  try {
    channels = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    channels = [];
  }
  for (const entry of channels) {
    if (!entry.isDirectory()) continue;
    const path = resolve(root, entry.name, "runtime-release-feed.signed.json");
    verifySignedRuntimeFeed(await readFile(path, "utf8"), undefined, entry.name, { feedVersion });
    checked += 1;
  }
}
console.log(`ok: ${checked} committed runtime release feeds`);
