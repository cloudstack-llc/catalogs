// Fetches models.dev, writes v1/prices.json, and refuses to publish a
// catalog that lost most of its coverage.
//
// Run: node scripts/generate.mjs [--out v1/prices.json]

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COST_UNIT,
  SCHEMA_VERSION,
  SOURCE_URL,
  checkRegression,
  serialize,
  transform,
} from "./transform.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FETCH_TIMEOUT_MS = 60_000;

function outputPath(argv) {
  const index = argv.indexOf("--out");
  if (index !== -1 && argv[index + 1] !== undefined) {
    return resolve(repoRoot, argv[index + 1]);
  }
  return resolve(repoRoot, "v1/prices.json");
}

async function readPrevious(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    // A previous file that exists but will not parse is a real problem: the
    // regression guard would silently pass with nothing to compare against.
    throw error;
  }
}

async function fetchUpstream() {
  const response = await fetch(SOURCE_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`upstream responded ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  return {
    payload: JSON.parse(body.toString("utf8")),
    etag: response.headers.get("etag") ?? undefined,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.byteLength,
  };
}

async function main() {
  const path = outputPath(process.argv.slice(2));
  const previous = await readPrevious(path);
  const upstream = await fetchUpstream();
  const { providers, counts } = transform(upstream.payload);

  const problems = checkRegression({ candidate: { counts }, previous });
  if (problems.length > 0) {
    // Exit without writing. Yesterday's prices are correct enough; a truncated
    // catalog is not.
    for (const problem of problems) {
      console.error(`refusing to publish: ${problem}`);
    }
    process.exit(1);
  }

  // generated_at changes on every run, so it is written only when the priced
  // data itself changed. Otherwise a no-op refresh would produce a commit whose
  // whole diff is a timestamp, and the history stops meaning "prices moved".
  const unchanged =
    previous !== undefined &&
    JSON.stringify(previous.providers) === JSON.stringify(providers);
  if (unchanged) {
    console.log(
      `unchanged: ${counts.models} models across ${counts.providers} providers`,
    );
    return;
  }

  const artifact = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    cost_unit: COST_UNIT,
    source: {
      url: SOURCE_URL,
      etag: upstream.etag,
      sha256: upstream.sha256,
      bytes: upstream.bytes,
    },
    counts,
    providers,
  };
  await writeFile(path, serialize(artifact), "utf8");
  console.log(
    `wrote ${path}: ${counts.models} models across ${counts.providers} providers` +
      (counts.dropped > 0 ? ` (${counts.dropped} dropped as invalid)` : ""),
  );
}

await main();
