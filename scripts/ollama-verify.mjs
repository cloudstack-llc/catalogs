// Validates the committed Ollama catalog without touching the network, so a
// pull request that edits it by hand fails in CI.
//
// Run: node scripts/ollama-verify.mjs [path]

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION, UNKNOWN_CONTEXT, checkGates, serialize } from "./ollama.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(repoRoot, process.argv[2] ?? "v1/ollama-models.json");

const text = await readFile(path, "utf8");
const artifact = JSON.parse(text);
const problems = [];

if (artifact.schema_version !== SCHEMA_VERSION) {
  problems.push(`schema_version is ${artifact.schema_version}, expected ${SCHEMA_VERSION}`);
}

// Every field the consuming schema requires, on every model. Consumers index
// these directly, so a single missing one is a crash rather than a gap.
const REQUIRED = ["name", "description", "tags", "params", "pulls", "updated"];
const names = new Set();
let tagCount = 0;
for (const model of artifact.models ?? []) {
  for (const field of REQUIRED) {
    if (!(field in model)) {
      problems.push(`${model.name ?? "<unnamed>"} is missing ${field}`);
    }
  }
  if (names.has(model.name)) {
    problems.push(`${model.name} appears more than once`);
  }
  names.add(model.name);
  for (const tag of model.tags ?? []) {
    tagCount += 1;
    const info = tag.model_info;
    if (info === undefined || typeof info !== "object") {
      problems.push(`${model.name}:${tag.tag} has no model_info`);
      continue;
    }
    for (const field of ["contextWindow", "parameters", "quantization"]) {
      if (typeof info[field] !== "string") {
        problems.push(`${model.name}:${tag.tag} model_info.${field} is not a string`);
      }
    }
    // An unknown context is the reference sentinel, never an empty string:
    // consumers render the value verbatim.
    if (info.contextWindow === "") {
      problems.push(`${model.name}:${tag.tag} has an empty contextWindow; expected ${UNKNOWN_CONTEXT}`);
    }
    if (typeof tag.size !== "string" || tag.size === "") {
      problems.push(`${model.name}:${tag.tag} has no size`);
    }
  }
}

// Some tags genuinely have no published metadata block — Ollama renders none
// for the -mlx and -nvfp4 variants. That is allowed, but it has to be declared,
// so a parser regression cannot hide inside a plausible-looking file.
const missing = (artifact.models ?? [])
  .flatMap((model) => model.tags ?? [])
  .filter((tag) => (tag.model_info?.parameters ?? "") === "").length;
if (missing !== artifact.counts?.missing_model_info) {
  problems.push(
    `counts claim ${artifact.counts?.missing_model_info} tags without model_info but ${missing} are empty`,
  );
}

if (tagCount !== artifact.counts?.tags || names.size !== artifact.counts?.models) {
  problems.push(
    `counts claim ${artifact.counts?.models}/${artifact.counts?.tags} but the body holds ${names.size}/${tagCount}`,
  );
}

for (const problem of checkGates({ candidate: artifact })) {
  problems.push(problem);
}

// Proves the file came out of the generator rather than an editor. This catches
// structural tampering, not a plausible value swapped for another plausible
// value — nothing offline can catch that.
if (serialize(artifact) !== text) {
  problems.push("file is not byte-identical to its serialized form");
}

if (problems.length > 0) {
  for (const problem of problems.slice(0, 20)) {
    console.error(`invalid artifact: ${problem}`);
  }
  if (problems.length > 20) {
    console.error(`...and ${problems.length - 20} more`);
  }
  process.exit(1);
}
console.log(`ok: ${names.size} models, ${tagCount} tags`);
