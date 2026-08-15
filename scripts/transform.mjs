// Pure transform from the models.dev api.json payload to the published
// artifact. Kept free of I/O so the shape rules are unit-testable and the
// workflow has nothing to mock.

export const SCHEMA_VERSION = 1;
export const SOURCE_URL = "https://models.dev/api.json";

// Upstream states costs in US dollars per one million tokens. The artifact
// keeps that unit unchanged: converting here would only add a rounding step
// between the source of truth and whatever reads this file.
export const COST_UNIT = "usd_per_million_tokens";

// A published rate above this is treated as corrupt rather than expensive. The
// priciest real model is under $500/M, so the ceiling leaves an order of
// magnitude of headroom while still catching a decimal-shift or a unit change
// upstream.
export const MAX_RATE = 10_000;

// Token limits above this are treated as corrupt. Context windows are still
// growing, so the ceiling is deliberately far above anything shipped.
const MAX_LIMIT = 1_000_000_000;

const RATE_FIELDS = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
  "input_audio",
  "output_audio",
];

function validRate(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RATE
  );
}

function validLimit(value) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_LIMIT
  );
}

function pickRates(cost) {
  const rates = {};
  for (const field of RATE_FIELDS) {
    if (field in cost) {
      if (!validRate(cost[field])) {
        return undefined;
      }
      rates[field] = cost[field];
    }
  }
  // Input and output are the contract. A model missing either cannot price a
  // request, and a partial entry is worse than an absent one because it reads
  // as authoritative.
  if (!("input" in rates) || !("output" in rates)) {
    return undefined;
  }
  return rates;
}

/**
 * Normalizes upstream tiered pricing.
 *
 * Only context-size tiers are published. Upstream also carries a legacy
 * `context_over_200k` object that duplicates a context tier; it is dropped
 * because two spellings of one fact invite readers to disagree.
 *
 * Tiers are sorted ascending by threshold so the applicable tier can be
 * selected with a single scan and no sort.
 */
function pickTiers(cost) {
  if (!Array.isArray(cost.tiers)) {
    return undefined;
  }
  const tiers = [];
  for (const entry of cost.tiers) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const tier = entry.tier;
    if (
      tier === null ||
      typeof tier !== "object" ||
      tier.type !== "context" ||
      !validLimit(tier.size)
    ) {
      continue;
    }
    const rates = pickRates(entry);
    if (rates === undefined) {
      continue;
    }
    tiers.push({ ...rates, above_context: tier.size });
  }
  if (tiers.length === 0) {
    return undefined;
  }
  tiers.sort((left, right) => left.above_context - right.above_context);
  return tiers;
}

function pickLimits(limit) {
  if (limit === null || typeof limit !== "object") {
    return {};
  }
  const limits = {};
  if (validLimit(limit.context)) {
    limits.context = limit.context;
  }
  if (validLimit(limit.output)) {
    limits.max_output = limit.output;
  }
  return limits;
}

/**
 * Builds the artifact body from an upstream payload.
 *
 * Every model that fails validation is dropped and counted rather than
 * repaired. A wrong price is worse than an absent one: an absent price renders
 * as unpriced, while a repaired one is a number nobody can trace to a source.
 */
export function transform(payload) {
  if (payload === null || typeof payload !== "object") {
    throw new Error("upstream payload is not an object");
  }
  const providers = {};
  let models = 0;
  let dropped = 0;
  for (const providerId of Object.keys(payload).sort()) {
    const provider = payload[providerId];
    if (provider === null || typeof provider !== "object") {
      continue;
    }
    const upstreamModels = provider.models;
    if (upstreamModels === null || typeof upstreamModels !== "object") {
      continue;
    }
    const priced = {};
    for (const modelId of Object.keys(upstreamModels).sort()) {
      const model = upstreamModels[modelId];
      if (model === null || typeof model !== "object") {
        continue;
      }
      const cost = model.cost;
      if (cost === null || typeof cost !== "object") {
        // Unpriced upstream (local runtimes, open weights). Not a drop: there
        // was never a price to lose.
        continue;
      }
      const rates = pickRates(cost);
      if (rates === undefined) {
        dropped += 1;
        continue;
      }
      const tiers = pickTiers(cost);
      priced[modelId] = {
        ...rates,
        ...pickLimits(model.limit),
        ...(tiers === undefined ? {} : { tiers }),
      };
      models += 1;
    }
    if (Object.keys(priced).length > 0) {
      providers[providerId] = priced;
    }
  }
  return {
    providers,
    counts: { providers: Object.keys(providers).length, models, dropped },
  };
}

// Field order for the per-model object. Serialization is byte-stable so a
// commit diff shows price movement and nothing else.
const MODEL_FIELD_ORDER = [
  ...RATE_FIELDS,
  "context",
  "max_output",
  "tiers",
];

function serializeModel(model) {
  const parts = [];
  for (const field of MODEL_FIELD_ORDER) {
    if (field in model) {
      parts.push(`${JSON.stringify(field)}:${JSON.stringify(model[field])}`);
    }
  }
  return `{${parts.join(",")}}`;
}

/**
 * Renders the artifact with one line per model.
 *
 * Compact JSON would serve fine and read smaller, but the git history is half
 * the point of this repo: a reviewer approving a price change should see the
 * changed models as changed lines, not one 600 KB line.
 */
export function serialize(artifact) {
  const lines = [
    "{",
    `  "schema_version": ${JSON.stringify(artifact.schema_version)},`,
    `  "generated_at": ${JSON.stringify(artifact.generated_at)},`,
    `  "cost_unit": ${JSON.stringify(artifact.cost_unit)},`,
    `  "source": ${JSON.stringify(artifact.source)},`,
    `  "counts": ${JSON.stringify(artifact.counts)},`,
    '  "providers": {',
  ];
  const providerIds = Object.keys(artifact.providers);
  providerIds.forEach((providerId, providerIndex) => {
    lines.push(`    ${JSON.stringify(providerId)}: {`);
    const models = artifact.providers[providerId];
    const modelIds = Object.keys(models);
    modelIds.forEach((modelId, modelIndex) => {
      const comma = modelIndex === modelIds.length - 1 ? "" : ",";
      lines.push(
        `      ${JSON.stringify(modelId)}: ${serializeModel(models[modelId])}${comma}`,
      );
    });
    lines.push(`    }${providerIndex === providerIds.length - 1 ? "" : ","}`);
  });
  lines.push("  }", "}");
  return `${lines.join("\n")}\n`;
}

/**
 * Guards a candidate artifact against the previous published one.
 *
 * The failure that matters is not a wrong number in one model — it is an
 * upstream shape change or a truncated fetch quietly publishing a mostly-empty
 * catalog. Coverage collapse is the signal that catches both.
 */
export function checkRegression({ candidate, previous, minCoverage = 0.7 }) {
  const problems = [];
  if (candidate.counts.models === 0) {
    problems.push("candidate has no priced models");
  }
  if (previous !== undefined && previous.counts?.models > 0) {
    const ratio = candidate.counts.models / previous.counts.models;
    if (ratio < minCoverage) {
      problems.push(
        `priced models fell to ${candidate.counts.models} from ${previous.counts.models} ` +
          `(${(ratio * 100).toFixed(1)}% of previous, floor ${(minCoverage * 100).toFixed(0)}%)`,
      );
    }
  }
  return problems;
}
