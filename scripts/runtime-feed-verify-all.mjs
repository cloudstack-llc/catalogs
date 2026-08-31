import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifySignedRuntimeFeed } from "./runtime-feed-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(repoRoot, "v2/runtime");
let channels;
try {
  channels = await readdir(root, { withFileTypes: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  channels = [];
}

let checked = 0;
for (const entry of channels) {
  if (!entry.isDirectory()) continue;
  const path = resolve(root, entry.name, "runtime-release-feed.signed.json");
  verifySignedRuntimeFeed(await readFile(path, "utf8"), undefined, entry.name);
  checked += 1;
}
console.log(`ok: ${checked} committed runtime release feeds`);
