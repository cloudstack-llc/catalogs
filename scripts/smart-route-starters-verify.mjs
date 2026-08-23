// Validates the curated Smart Route starter artifact without using the network.
//
// Run: node scripts/smart-route-starters-verify.mjs [path]

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSmartRouteStarters } from "./smart-route-starters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(repoRoot, process.argv[2] ?? "v1/smart-route-starters.json");
const text = await readFile(path, "utf8");
const artifact = JSON.parse(text);
const problems = validateSmartRouteStarters(artifact);

if (`${JSON.stringify(artifact, null, 2)}\n` !== text) {
  problems.push("file must use the canonical two-space JSON format");
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`invalid artifact: ${problem}`);
  process.exit(1);
}

const lanes = artifact.starters.reduce((total, starter) => total + starter.lanes.length, 0);
console.log(
  `ok: ${artifact.starters.length} Smart Route starters, ${artifact.collections.length} collections, ${lanes} lanes`,
);
