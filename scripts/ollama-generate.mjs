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
  USER_AGENT,
  buildArtifact,
  checkGates,
  derivationMismatches,
  parseDetail,
  parseLibrary,
  parseTags,
  serialize,
  stableView,
} from "./ollama.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = resolve(repoRoot, "v1/ollama-model-info-cache.json");

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

async function fetchText(url) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
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
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`${url} responded ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || String(error).includes("aborting the run")) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, 1000 * attempt));
    }
  }
  return undefined;
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
  const cache = (await readJSON(CACHE_PATH)) ?? { entries: {} };

  const libraryHTML = await fetchText(LIBRARY_URL);
  if (libraryHTML === undefined) {
    throw new Error("library index did not respond");
  }
  let models = parseLibrary(libraryHTML);
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
  for (const [index, model] of models.entries()) {
    const html = tagPages[index];
    tagsByModel.set(model.name, html === undefined ? { tags: [], cloudTags: [] } : parseTags(html, model.name));
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
    } else {
      detail.set(key, cached);
    }
  }
  console.log(`model_info: ${detail.size} cached, ${missing.length} to fetch`);

  let failed = 0;
  const fetched = await mapLimited(missing, async ([key, tag]) => {
    const html = await fetchText(`${LIBRARY_URL}/${tag.model}:${tag.tag}`);
    if (html === undefined) {
      failed += 1;
      return [key, undefined];
    }
    return [key, parseDetail(html)];
  });
  for (const [key, info] of fetched) {
    if (info !== undefined) {
      detail.set(key, info);
      cache.entries[key] = info;
    }
  }
  if (failed > 0) {
    console.log(`model_info: ${failed} detail pages unavailable`);
  }

  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const artifact = buildArtifact({ models, tagsByModel, detail, generatedAt });

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
