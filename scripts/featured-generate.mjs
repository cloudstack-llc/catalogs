// Rebuilds v1/featured-models.json from scripts/featured-curation.mjs, the
// committed v1/ollama-models.json, and the Hugging Face API.
//
// Run: node scripts/featured-generate.mjs [--out v1/featured-models.json] [--force]
//
// The curation decides which models appear; this refreshes everything else
// (files, sizes, parameters, context, popularity). Any reference it cannot
// confirm fails the run without writing, so yesterday's file stands. --force
// writes even when only generated_at or popularity moved.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { COLLECTIONS, MODELS } from "./featured-curation.mjs";
import { buildArtifact, hubReferences, indexOllama, serialize, stableView } from "./featured.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "https://huggingface.co";
const USER_AGENT = "msty-model-catalog/1.0 (+https://github.com/cloudstack-llc/catalogs)";
const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;

// Returns the parsed body, or null when the Hub said the thing does not exist
// or never answered. Both mean "unconfirmed", which the builder treats as a
// problem; retries cover the transient case.
async function fetchJSON(url) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        await new Promise((done) => setTimeout(done, Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt));
        continue;
      }
      if (!response.ok) {
        console.error(`${url} responded ${response.status}`);
        return null;
      }
      return { body: await response.json(), next: nextPage(response.headers.get("link")) };
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(`${url} failed: ${error}`);
        return null;
      }
    }
  }
  console.error(`${url} kept failing`);
  return null;
}

// The tree endpoint pages large repositories through a Link header.
function nextPage(link) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(link ?? "");
  return match ? match[1] : undefined;
}

async function tree(repo) {
  const files = [];
  let url = `${HUB}/api/models/${repo}/tree/main?recursive=true`;
  while (url) {
    const page = await fetchJSON(url);
    if (!page || !Array.isArray(page.body)) return null;
    files.push(...page.body.filter((entry) => entry.type === "file"));
    url = page.next;
  }
  return files;
}

async function stats(repo) {
  const page = await fetchJSON(`${HUB}/api/models/${repo}`);
  const downloads = Number(page?.body?.downloads);
  const likes = Number(page?.body?.likes);
  if (!Number.isFinite(downloads) || !Number.isFinite(likes)) return null;
  return { downloads: Math.max(0, Math.trunc(downloads)), likes: Math.max(0, Math.trunc(likes)) };
}

async function mapLimited(items, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: { out: { type: "string", default: "v1/featured-models.json" }, force: { type: "boolean", default: false } },
  });
  const outputPath = resolve(repoRoot, values.out);
  const curation = { models: MODELS, collections: COLLECTIONS };
  const ollama = indexOllama(JSON.parse(await readFile(resolve(repoRoot, "v1/ollama-models.json"), "utf8")));
  let previous;
  try {
    previous = JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    previous = undefined;
  }

  const refs = hubReferences(curation);
  const [trees, repoStats, bases, configs] = await Promise.all([
    mapLimited(refs.repos, tree),
    mapLimited(refs.repos, stats),
    mapLimited(refs.bases, async (repo) => (await fetchJSON(`${HUB}/api/models/${repo}`))?.body ?? null),
    mapLimited(refs.configs, async (repo) => (await fetchJSON(`${HUB}/${repo}/resolve/main/config.json`))?.body ?? null),
  ]);
  const zip = (keys, list) => new Map(keys.map((key, index) => [key, list[index]]));
  const hub = {
    trees: zip(refs.repos, trees),
    stats: zip(refs.repos, repoStats),
    bases: zip(refs.bases, bases),
    configs: zip(refs.configs, configs),
  };

  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const { artifact, problems, notes } = buildArtifact({ curation, ollama, hub, generatedAt });
  for (const note of notes) console.log(`note: ${note}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`refusing to publish: ${problem}`);
    process.exit(1);
  }

  const counts = `${artifact.models.length} models, ${artifact.collections.length} collections, ` +
    `${artifact.models.reduce((sum, model) => sum + model.installs.length, 0)} installs`;
  if (!values.force && previous && JSON.stringify(stableView(previous)) === JSON.stringify(stableView(artifact))) {
    console.log(`unchanged: ${counts}`);
    return;
  }
  await writeFile(outputPath, serialize(artifact), "utf8");
  console.log(`wrote ${values.out}: ${counts}`);
}

await main();
