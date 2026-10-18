// Validates the committed featured list without using the network: its shape,
// and that it still matches scripts/featured-curation.mjs.
//
// Run: node scripts/featured-verify.mjs [path]

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COLLECTIONS, MODELS } from "./featured-curation.mjs";
import { serialize, validateCuration, validateFeatured } from "./featured.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(repoRoot, process.argv[2] ?? "v1/featured-models.json");
const text = await readFile(path, "utf8");
const artifact = JSON.parse(text);
const curation = { models: MODELS, collections: COLLECTIONS };
const problems = [...validateCuration(curation), ...validateFeatured(artifact, curation)];

if (serialize(artifact) !== text) {
  problems.push("file must use the canonical two-space JSON format");
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`invalid artifact: ${problem}`);
  process.exit(1);
}

const installs = artifact.models.reduce((total, model) => total + model.installs.length, 0);
console.log(`ok: ${artifact.models.length} featured models, ${artifact.collections.length} collections, ${installs} installs`);
