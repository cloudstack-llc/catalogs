// Crawls ollama.com and writes v1/ollama-models.json.
//
// Run: node scripts/ollama-generate.mjs [--out v1/ollama-models.json] [--limit N]
//
// A cold run is ~6,500 requests; a warm one is a few hundred, because
// parameters and quantization are immutable for a layer digest and are cached
// beside the artifact.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIBRARY_URL,
  MANIFEST_ACCEPT,
  MODEL_LAYER,
  REGISTRY_URL,
  USER_AGENT,
  buildArtifact,
  checkGates,
  derivationMismatches,
  parseDetail,
  parseGGUFShape,
  parseLibrary,
  parseTags,
  serialize,
  stableView,
} from "./ollama.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = resolve(repoRoot, "v1/ollama-model-info-cache.json");
const CACHE_VERSION = 1;
// Marks a page that genuinely renders no metadata block, so it is not refetched
// on every run and is never mistaken for a fetch failure.
const ABSENT = Symbol("absent");

// Shapes come from the registry `ollama pull` uses, not from ollama.com pages.
// A shape is fixed for a digest, so each is read once and kept here. The
// version is bumped when SHAPE_KEYS or the GGUF reader changes.
const SHAPE_CACHE_PATH = resolve(repoRoot, "v1/ollama-shape-cache.json");
const SHAPE_CACHE_VERSION = 1;
// The shape sits near the start of the header. A few files put long tables
// before it, so a short read that ends too soon is tried once more, longer.
const SHAPE_READ_BYTES = [256 * 1024, 4 * 1024 * 1024];

// ollama.com publishes no robots.txt and no crawl policy. Absence of a policy
// is not permission, so the crawl stays deliberately gentle: the job has twelve
// hours to do three minutes of work.
const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
// A run that hits this many 429s has been told to stop, and publishing a
// half-crawled catalog is worse than publishing nothing.
const MAX_RATE_LIMITED = 5;

let rateLimited = 0;

// A fetch has three outcomes, and collapsing them is how a failed crawl gets
// published as a smaller catalog: "ok" has a body, "missing" means the server
// said it does not exist, and "failed" means we never found out.
async function fetchText(url, { headers = { Accept: "text/html" }, read = (response) => response.text() } = {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status >= 500) {
        if (response.status === 429) {
          rateLimited += 1;
          if (rateLimited > MAX_RATE_LIMITED) {
            throw new Error("rate limited repeatedly; aborting the run");
          }
        }
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        const backoff = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await new Promise((done) => setTimeout(done, backoff));
        continue;
      }
      if (response.status === 404) {
        return { status: "missing" };
      }
      if (!response.ok) {
        throw new Error(`${url} responded ${response.status}`);
      }
      return { status: "ok", body: await read(response) };
    } catch (error) {
      if (String(error).includes("aborting the run")) {
        throw error;
      }
      if (attempt === MAX_ATTEMPTS) {
        return { status: "failed", error: String(error) };
      }
      await new Promise((done) => setTimeout(done, 1000 * attempt));
    }
  }
  return { status: "failed", error: `${url} did not respond after ${MAX_ATTEMPTS} attempts` };
}

/**
 * Reads at most limit bytes of a response body, then stops the download. A
 * server that ignores the Range header answers with the whole multi-gigabyte
 * file; this keeps that from mattering.
 */
async function readPrefix(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel();
  const bytes = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * Reads one tag's shape: its manifest names the GGUF weights blob, and the
 * blob's opening bytes hold the shape. Returns ABSENT when the tag has no GGUF
 * (MLX-format tags ship tensors instead) or its header names no shape, and
 * undefined when the registry could not be read, which is retried next run.
 */
async function readShape(model, tag) {
  const base = `${REGISTRY_URL}/v2/library/${encodeURIComponent(model)}`;
  const manifest = await fetchText(`${base}/manifests/${encodeURIComponent(tag)}`, {
    headers: { Accept: MANIFEST_ACCEPT },
    read: (response) => response.json(),
  });
  if (manifest.status !== "ok") {
    return manifest.status === "missing" ? ABSENT : undefined;
  }
  const layer = manifest.body.layers?.find((entry) => entry.mediaType === MODEL_LAYER);
  if (layer === undefined || !/^sha256:[0-9a-f]{64}$/.test(layer.digest ?? "")) {
    return ABSENT;
  }
  for (const size of SHAPE_READ_BYTES) {
    const blob = await fetchText(`${base}/blobs/${layer.digest}`, {
      headers: { Range: `bytes=0-${size - 1}` },
      read: (response) => readPrefix(response, size),
    });
    if (blob.status !== "ok") {
      return blob.status === "missing" ? ABSENT : undefined;
    }
    try {
      const shape = parseGGUFShape(blob.body);
      if (shape !== undefined) {
        return shape;
      }
    } catch {
      return ABSENT;
    }
  }
  return ABSENT;
}

/** Runs tasks with a fixed number of workers, preserving input order. */
async function mapLimited(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const outputPath = resolve(repoRoot, argValue(argv, "--out") ?? "v1/ollama-models.json");
  const limit = Number.parseInt(argValue(argv, "--limit") ?? "", 10);

  const previous = await readJSON(outputPath);
  const stored = await readJSON(CACHE_PATH);
  // The cache holds values derived by a specific parser. Bumping the version
  // when the parsers change is what stops a fixed bug from being served out of
  // yesterday's cache.
  const cache =
    stored?.version === CACHE_VERSION ? stored : { version: CACHE_VERSION, entries: {} };
  if (stored !== undefined && stored.version !== CACHE_VERSION) {
    console.log("model_info cache version changed; refetching");
  }

  const libraryResult = await fetchText(LIBRARY_URL);
  if (libraryResult.status !== "ok") {
    throw new Error(`library index did not respond (${libraryResult.status})`);
  }
  let models = parseLibrary(libraryResult.body);
  if (models.length === 0) {
    throw new Error("library index parsed to zero models; the markup has changed");
  }
  if (Number.isFinite(limit)) {
    models = models.slice(0, limit);
  }
  console.log(`library: ${models.length} models`);

  const tagPages = await mapLimited(models, (model) =>
    fetchText(`${LIBRARY_URL}/${model.name}/tags`));
  const tagsByModel = new Map();
  const unreadable = [];
  for (const [index, model] of models.entries()) {
    const result = tagPages[index];
    if (result.status !== "ok") {
      // Publishing this model with an empty tag list would be indistinguishable
      // from a cloud-only model that genuinely has none, and the shrunken
      // catalog would become the next run's baseline.
      unreadable.push(`${model.name} (${result.status})`);
      continue;
    }
    tagsByModel.set(model.name, parseTags(result.body, model.name));
  }
  if (unreadable.length > 0) {
    console.error(`refusing to publish: ${unreadable.length} tag pages could not be read`);
    for (const entry of unreadable.slice(0, 10)) {
      console.error(`  ${entry}`);
    }
    process.exit(1);
  }
  const allTags = models.flatMap((model) => {
    const parsed = tagsByModel.get(model.name);
    return parsed.tags.map((tag) => ({ model: model.name, ...tag }));
  });
  console.log(`tags: ${allTags.length}`);

  // Tags sharing a layer digest share their metadata, so each digest is
  // fetched once and remembered across runs.
  const wanted = new Map();
  for (const tag of allTags) {
    const key = `${tag.model}@${tag.digest}`;
    if (!wanted.has(key)) {
      wanted.set(key, tag);
    }
  }
  const detail = new Map();
  const missing = [];
  for (const [key, tag] of wanted) {
    const cached = cache.entries[key];
    if (cached === undefined) {
      missing.push([key, tag]);
    } else if (cached.absent !== true) {
      detail.set(key, cached);
    }
  }
  console.log(`model_info: ${detail.size} cached, ${missing.length} to fetch`);

  let failed = 0;
  const fetched = await mapLimited(missing, async ([key, tag]) => {
    const result = await fetchText(`${LIBRARY_URL}/${tag.model}:${tag.tag}`);
    if (result.status === "failed") {
      failed += 1;
      return [key, undefined];
    }
    if (result.status === "missing") {
      return [key, ABSENT];
    }
    return [key, parseDetail(result.body) ?? ABSENT];
  });
  for (const [key, info] of fetched) {
    if (info === undefined) {
      continue;
    }
    if (info !== ABSENT) {
      detail.set(key, info);
    }
    // Only a complete parse is remembered. A page that renders no metadata
    // block at all is remembered as absent so it is not refetched forever, but
    // a partial parse is never cached: a markup change that empties one field
    // would otherwise be baked in and outlive the fix.
    if (info === ABSENT) {
      cache.entries[key] = { absent: true };
    } else if (info.parameters !== "" && info.quantization !== "") {
      cache.entries[key] = info;
    }
  }
  if (failed > 0) {
    console.error(`model_info: ${failed} detail pages could not be read`);
  }
  if (failed > Math.max(5, missing.length * 0.01)) {
    console.error("refusing to publish: too many detail pages failed");
    process.exit(1);
  }

  const storedShapes = await readJSON(SHAPE_CACHE_PATH);
  const shapeCache =
    storedShapes?.version === SHAPE_CACHE_VERSION
      ? storedShapes
      : { version: SHAPE_CACHE_VERSION, entries: {} };
  const shapes = new Map();
  const unshaped = [];
  for (const [key, tag] of wanted) {
    const cached = shapeCache.entries[key];
    if (cached === undefined) {
      unshaped.push([key, tag]);
    } else if (cached.absent !== true) {
      shapes.set(key, cached);
    }
  }
  console.log(`shapes: ${shapes.size} cached, ${unshaped.length} to read`);
  let shapesFailed = 0;
  const read = await mapLimited(unshaped, async ([key, tag]) => [key, await readShape(tag.model, tag.tag)]);
  for (const [key, shape] of read) {
    if (shape === undefined) {
      shapesFailed += 1;
    } else if (shape === ABSENT) {
      shapeCache.entries[key] = { absent: true };
    } else {
      shapeCache.entries[key] = shape;
      shapes.set(key, shape);
    }
  }
  // Saved before any gate: each entry is a fact about one digest, true
  // whether or not this run publishes, and a cold read is the slow part.
  await writeFile(SHAPE_CACHE_PATH, `${JSON.stringify(shapeCache, null, 1)}\n`, "utf8");
  if (shapesFailed > 0) {
    console.error(`shapes: ${shapesFailed} could not be read`);
  }
  if (shapesFailed > Math.max(5, unshaped.length * 0.01)) {
    console.error("refusing to publish: too many shapes could not be read");
    process.exit(1);
  }

  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const artifact = buildArtifact({ models, tagsByModel, detail, shapes, generatedAt });

  const problems = checkGates({ candidate: artifact, previous });
  if (problems.length > 0) {
    // Leave the committed artifact alone. Yesterday's catalog is correct
    // enough; a hollowed-out one is not, and it reaches every install.
    for (const problem of problems) {
      console.error(`refusing to publish: ${problem}`);
    }
    process.exit(1);
  }

  const canary = derivationMismatches(artifact);
  console.log(
    `canary: ${canary.mismatched}/${canary.checked} tag names disagree with scraped parameters ` +
      `(${(canary.rate * 100).toFixed(2)}%)`,
  );
  if (canary.rate > 0.05) {
    console.error("refusing to publish: tag names and scraped parameters disagree too often");
    process.exit(1);
  }

  // generated_at moves every run, so it is written only when the catalog
  // itself changed. Otherwise the history stops meaning "the library moved".
  if (previous !== undefined && JSON.stringify(stableView(previous)) === JSON.stringify(stableView(artifact))) {
    console.log(`unchanged: ${artifact.counts.models} models, ${artifact.counts.tags} tags`);
    // The cache still earned its keep even when nothing else changed.
    await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 1)}\n`, "utf8");
    return;
  }

  await writeFile(outputPath, serialize(artifact), "utf8");
  await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 1)}\n`, "utf8");
  console.log(`wrote ${outputPath}: ${artifact.counts.models} models, ${artifact.counts.tags} tags`);
}

await main();
