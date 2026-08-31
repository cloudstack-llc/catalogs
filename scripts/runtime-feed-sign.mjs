import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_KEY_ID,
  signRuntimeFeed,
} from "./runtime-feed-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

const argv = process.argv.slice(2);
const input = resolve(repoRoot, required(option(argv, "--input"), "--input"));
const out = resolve(repoRoot, required(option(argv, "--out"), "--out"));
const keyEnvironment = required(
  option(argv, "--private-key-env", "MSTY_NEXUS_RUNTIME_RELEASE_FEED_PRIVATE_KEY"),
  "--private-key-env",
);
const key = required(process.env[keyEnvironment], keyEnvironment);
const keyId = required(option(argv, "--key-id", DEFAULT_KEY_ID), "--key-id");
const feed = JSON.parse(await readFile(input, "utf8"));
await writeFile(out, signRuntimeFeed(feed, key, keyId), "utf8");
console.log(`signed ${input} as ${out}`);
