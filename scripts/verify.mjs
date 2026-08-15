// Validates the committed artifact without touching the network, so a pull
// request that edits v1/prices.json by hand fails in CI.
//
// Run: node scripts/verify.mjs [path]

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COST_UNIT, MAX_RATE, SCHEMA_VERSION, serialize } from "./transform.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(repoRoot, process.argv[2] ?? "v1/prices.json");

const text = await readFile(path, "utf8");
const artifact = JSON.parse(text);
const problems = [];

if (artifact.schema_version !== SCHEMA_VERSION) {
  problems.push(
    `schema_version is ${artifact.schema_version}, expected ${SCHEMA_VERSION}`,
  );
}
if (artifact.cost_unit !== COST_UNIT) {
  problems.push(`cost_unit is ${artifact.cost_unit}, expected ${COST_UNIT}`);
}

let providers = 0;
let models = 0;
for (const [providerId, entries] of Object.entries(artifact.providers ?? {})) {
  providers += 1;
  for (const [modelId, model] of Object.entries(entries)) {
    models += 1;
    if (!(typeof model.input === "number" && typeof model.output === "number")) {
      problems.push(`${providerId}/${modelId} is missing input or output`);
      continue;
    }
    for (const [field, value] of Object.entries(model)) {
      if (typeof value === "number" && (value < 0 || value > MAX_RATE) && field !== "context" && field !== "max_output") {
        problems.push(`${providerId}/${modelId}.${field} is out of range: ${value}`);
      }
    }
  }
}
if (providers !== artifact.counts?.providers || models !== artifact.counts?.models) {
  problems.push(
    `counts claim ${artifact.counts?.providers}/${artifact.counts?.models} ` +
      `but the body holds ${providers}/${models}`,
  );
}

// The file must be exactly what the serializer produces from its own contents,
// which proves it came out of the generator rather than an editor. This catches
// structural tampering — reordered fields, injected keys, whitespace — but not
// a plausible number swapped for another plausible number. Nothing offline can:
// a malicious price is shaped exactly like a real price change. Branch
// protection covers that case, not this check.
if (serialize(artifact) !== text) {
  problems.push("file is not byte-identical to its serialized form");
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`invalid artifact: ${problem}`);
  }
  process.exit(1);
}
console.log(`ok: ${models} models across ${providers} providers`);
