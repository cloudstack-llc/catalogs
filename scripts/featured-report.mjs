// Lists mlx-community repositories that may be newer versions of featured
// models, as Markdown for a maintainer to review. It changes nothing: a lead
// becomes a featured model only through a reviewed edit of
// scripts/featured-curation.mjs.
//
// Run: node scripts/featured-report.mjs >> "$GITHUB_STEP_SUMMARY"
//
// Each curated model may name a `watch` term ("GLM-", "MiniMax-M"). A lead is a
// repository whose name starts with that term, uploaded after the newest
// featured repository that shares the term, that is not another quantization of
// a featured model or an obvious derivative (abliterated, distilled, merged),
// and that people have started to download. It is a heuristic: expect some
// noise, such as other sizes of a featured family.

import { COLLECTIONS, MODELS } from "./featured-curation.mjs";

const HUB = "https://huggingface.co";
const USER_AGENT = "msty-model-catalog/1.0 (+https://github.com/cloudstack-llc/catalogs)";
const AUTHOR = "mlx-community";
const MIN_DOWNLOADS = 200;
const PER_TERM = 5;
const DERIVATIVE = /abliterat|obliterat|uncensor|heretic|distill|merge|reap|claude|opus|gemini|deckard|aeon|sft|lora|test|nsfw|caption/i;
// Not chat models, so never a newer version of one.
const OTHER_JOB = /music|speech|asr|tts|diariz|parse|audio|whisper/i;
// Quantization and packaging suffixes, stripped so "GLM-5.3-8bit" and
// "GLM-5.3-4bit" read as the same model.
const PACKAGING = /[-_](?:mlx|\d+(?:\.\d+)?-?bits?|mxfp\d+|nvfp\d+|fp\d+|bf16|q\d+|dq\d.*|mixed.*|dwq.*|optiq.*|oq\d.*|gs\d+|qat|mtp|dflash\d*)$/i;

// The repository name without its owner or an uploader's "publisher_" prefix.
function bare(repo) {
  return repo.slice(repo.indexOf("/") + 1).replace(/^[a-z0-9-]+_/i, "").toLowerCase();
}

function stem(repo) {
  let name = bare(repo);
  for (let previous = ""; previous !== name;) {
    previous = name;
    name = name.replace(PACKAGING, "");
  }
  return name;
}

async function getJSON(url) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const featuredRepos = MODELS.flatMap((model) => [model.mlx, model.gguf]).filter(Boolean);
  const featuredStems = new Set(featuredRepos.map(stem));
  const byTerm = new Map();
  for (const model of MODELS) {
    if (model.watch && model.mlx) byTerm.set(model.watch, [...(byTerm.get(model.watch) ?? []), model]);
  }

  const lines = ["## Featured models: possible newer versions", ""];
  let leads = 0;
  for (const [term, models] of byTerm) {
    const created = await Promise.all(models.map(async (model) => (await getJSON(`${HUB}/api/models/${model.mlx}`))?.createdAt));
    const newest = created.filter(Boolean).sort().at(-1);
    if (!newest) {
      lines.push(`- \`${term}\`: featured repositories unreadable, skipped`);
      continue;
    }
    const found = await getJSON(
      `${HUB}/api/models?author=${AUTHOR}&search=${encodeURIComponent(term)}&sort=createdAt&direction=-1&limit=100`,
    );
    const candidates = (found ?? [])
      .filter((repo) => repo.createdAt > newest && (repo.downloads ?? 0) >= MIN_DOWNLOADS)
      .filter((repo) => bare(repo.id).startsWith(term.toLowerCase()))
      .filter((repo) => !DERIVATIVE.test(repo.id) && !OTHER_JOB.test(repo.id) && !featuredStems.has(stem(repo.id)))
      .filter((repo, index, all) => all.findIndex((other) => stem(other.id) === stem(repo.id)) === index)
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, PER_TERM);
    if (candidates.length === 0) continue;
    leads += candidates.length;
    lines.push(`### \`${term}\` (featured: ${models.map((model) => model.id).join(", ")})`, "");
    for (const repo of candidates) {
      lines.push(`- [${repo.id}](${HUB}/${repo.id}): ${repo.downloads} downloads, uploaded ${repo.createdAt.slice(0, 10)}`);
    }
    lines.push("");
  }
  if (leads === 0) lines.push("No leads today.");
  const cluster = COLLECTIONS.find((collection) => collection.id === "cluster");
  lines.push(
    "",
    `Before adding a lead to the \`${cluster.id}\` collection, check that the Msty Nexus cluster worker can split its ` +
      "model family and that it loads without trust_remote_code.",
  );
  console.log(lines.join("\n"));
}

await main();
