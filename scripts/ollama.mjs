// Pure parsing and shaping for the Ollama library catalog. No I/O, so the
// selectors can be tested against fixture HTML.
//
// Ollama publishes no API. Every API-shaped path 404s, and ollama.com/api/tags
// is a decoy that returns hosted cloud models with empty metadata rather than
// the library. The catalog therefore comes from server-rendered HTML, which is
// presentation markup and will change without warning — everything here is
// written to fail loudly rather than quietly emit an emptier catalog.

export const SCHEMA_VERSION = 1;
export const LIBRARY_URL = "https://ollama.com/library";

// A truthful agent string with a contact URL. ollama.com serves it the same as
// a browser's, so there is no reason to claim to be one.
export const USER_AGENT =
  "msty-model-catalog/1.0 (+https://github.com/cloudstack-llc/model-catalog)";

// The registry `ollama pull` reads. A tag's manifest names its weights blob,
// and the blob is a GGUF file whose header holds the model's shape.
export const REGISTRY_URL = "https://registry.ollama.ai";
export const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json";
export const MODEL_LAYER = "application/vnd.ollama.image.model";

// The GGUF keys Msty Nexus's memory-fit estimate reads, without the "{arch}."
// prefix (msty-nexus internal/fitmeta FromGGUF). Only these are published: a
// shape is a few numbers, and the whole file must stay small enough for every
// Runtime to download. Adding a key means bumping SHAPE_CACHE_VERSION in
// ollama-generate.mjs so cached shapes are read again.
export const SHAPE_KEYS = [
  "block_count",
  "layers",
  "embedding_length",
  "context_length",
  "attention.head_count",
  "attention.head_count_kv",
  "attention.key_length",
  "attention.key_length_mla",
  "attention.kv_lora_rank",
  "attention.qk_rope_head_dim",
  "rope.dimension_count",
  "attention.sliding_window",
];

const GGUF_INTEGER_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 10: 8, 11: 8 };
const GGUF_FIXED_BYTES = { ...GGUF_INTEGER_BYTES, 6: 4, 7: 1, 12: 8 };
const GGUF_STRING = 8;
const GGUF_ARRAY = 9;

class Truncated extends Error {}

/**
 * Reads a model's shape from the opening bytes of a GGUF file.
 *
 * Returns { arch, shape } once the header has named the architecture and its
 * layer and head counts and the reader has passed every key that could still
 * add to the shape: the end of the key list, or the tokenizer keys, which
 * writers put after the architecture's own (the Runtime's reader stops there
 * too). Returns undefined when the bytes ran out first, so the caller can read
 * further. Throws for a file that is not GGUF or names no shape.
 */
export function parseGGUFShape(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  const need = (count) => {
    if (offset + count > view.byteLength) {
      throw new Truncated();
    }
  };
  const u32 = () => {
    need(4);
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const u64 = () => {
    need(8);
    const value = view.getBigUint64(offset, true);
    offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("gguf length out of range");
    }
    return Number(value);
  };
  const string = () => {
    const length = u64();
    need(length);
    const value = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  const integer = (type) => {
    need(GGUF_INTEGER_BYTES[type]);
    let value;
    switch (type) {
      case 0: value = view.getUint8(offset); break;
      case 1: value = view.getInt8(offset); break;
      case 2: value = view.getUint16(offset, true); break;
      case 3: value = view.getInt16(offset, true); break;
      case 4: value = view.getUint32(offset, true); break;
      case 5: value = view.getInt32(offset, true); break;
      case 10: value = Number(view.getBigUint64(offset, true)); break;
      default: value = Number(view.getBigInt64(offset, true));
    }
    offset += GGUF_INTEGER_BYTES[type];
    return value;
  };
  const skip = (type) => {
    if (type === GGUF_STRING) {
      const length = u64();
      need(length);
      offset += length;
    } else if (type === GGUF_ARRAY) {
      const itemType = u32();
      const count = u64();
      if (itemType in GGUF_FIXED_BYTES) {
        need(count * GGUF_FIXED_BYTES[itemType]);
        offset += count * GGUF_FIXED_BYTES[itemType];
      } else {
        for (let index = 0; index < count; index += 1) {
          skip(itemType);
        }
      }
    } else if (type in GGUF_FIXED_BYTES) {
      need(GGUF_FIXED_BYTES[type]);
      offset += GGUF_FIXED_BYTES[type];
    } else {
      throw new Error(`unknown gguf value type ${type}`);
    }
  };

  if (bytes.byteLength < 4 || decoder.decode(bytes.subarray(0, 4)) !== "GGUF") {
    throw new Error("not a gguf file");
  }
  offset = 4;
  let arch = "";
  const values = new Map();
  const has = (name) => values.has(`${arch}.${name}`);
  const complete = () =>
    arch !== "" && (has("block_count") || has("layers")) && has("attention.head_count");
  const result = () => {
    const shape = {};
    for (const key of SHAPE_KEYS) {
      if (has(key)) {
        shape[key] = values.get(`${arch}.${key}`);
      }
    }
    return { arch, shape };
  };
  try {
    const version = u32();
    if (version < 2) {
      throw new Error(`gguf version ${version} is not supported`);
    }
    u64(); // tensor count
    const keyCount = u64();
    for (let index = 0; index < keyCount; index += 1) {
      const key = string();
      if (key.startsWith("tokenizer.") && complete()) {
        return result();
      }
      const type = u32();
      if (key === "general.architecture" && type === GGUF_STRING) {
        arch = string();
        continue;
      }
      // Kept by full key: the architecture may be named after its own keys.
      const dot = key.indexOf(".");
      if (dot > 0 && type in GGUF_INTEGER_BYTES && SHAPE_KEYS.includes(key.slice(dot + 1))) {
        const value = integer(type);
        if (Number.isSafeInteger(value)) {
          values.set(key, value);
        }
        continue;
      }
      skip(type);
    }
  } catch (error) {
    if (error instanceof Truncated) {
      return undefined;
    }
    throw error;
  }
  if (!complete()) {
    throw new Error("gguf header names no model shape");
  }
  return result();
}

const LIBRARY_ENTRY =
  /<li\s+class="flex items-baseline border-b border-neutral-200 py-6">\s*<a href="\/library\/([^"]+)"([\s\S]*?)<\/li>/g;
const DESCRIPTION =
  /<p class="max-w-lg break-words text-neutral-800 text-md">([\s\S]*?)<\/p>/;
// Capability chips and parameter-size chips differ only by Tailwind colour, and
// DOM order is the order the reference artifact stores them in.
const CHIP =
  /<span\s*class="inline-flex items-center rounded-md bg-(?:indigo-50|cyan-50|\[#ddf4ff\]) px-2 py-0\.5 text-xs font-medium text-(?:indigo-600|cyan-500|blue-600) sm:text-\[13px\]">([^<]+)<\/span>/g;
// Anchored on the download-arrow icon path: the count has no class of its own.
const PULLS = /M3 16\.5v2\.25A2\.25[\s\S]*?<\/svg>\s*<span >([^<]+)<\/span>/;
const UPDATED =
  /<span class="hidden sm:flex">Updated&nbsp;<\/span>\s*<span >([^<]+)<\/span>/;
// The wrapping span carries the absolute time the relative string is derived
// from — strictly better data, and free.
const UPDATED_TITLE = /<span class="flex items-center" title="([^"]+)">/;

// The mobile block is the one to parse. The desktop grid renders cloud rows as
// bar-graph elements with no text, so it silently yields zero tags for
// cloud-only models; the mobile block renders uniform text for both.
const TAG_ROW =
  /<a href="\/library\/([^"]+)" class="md:hidden flex flex-col space-y-\[6px\] group">([\s\S]*?)<\/a>/g;
const TAG_BODY =
  /<span class="font-mono">\s*([0-9a-f]+)<\/span>\s*•\s*([\s\S]*?)\s*•\s*([\s\S]*?)\s*context window/;
const NO_MODELS = /No models/;

// Anchored on the label text, never on position: a bare search for
// "quantization" also matches README prose further down the page.
const DETAIL_FIELD =
  /<span class="hidden sm:block">(arch|parameters|quantization)<\/span><span class="text-neutral-400 sm:font-semibold sm:text-neutral-800 sm:text-xs">([^<]*)<\/span>/g;

const HTML_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " ", "#183": "·",
};

function unescapeHTML(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity) => {
    if (entity in HTML_ENTITIES) {
      return HTML_ENTITIES[entity];
    }
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return match;
  });
}

function text(value) {
  return unescapeHTML(value.replace(/<[^>]+>/g, ""))
    .replace(/ /g, " ")
    .trim();
}

/**
 * Decodes a humanized pull count so consumers can sort without re-parsing.
 *
 * The site publishes only the display string, so this is a decoded
 * approximation and never a true count.
 */
export function approximatePulls(pulls) {
  const match = /^([\d.,]+)\s*([KMB])?$/.exec(pulls.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[match[2]] ?? 1;
  return Math.round(value * scale);
}

/** Converts "Nov 30, 2024 10:34 PM UTC" to an ISO 8601 instant. */
export function parseUpdatedAt(title) {
  const parsed = Date.parse(title.replace(/\s*UTC$/, " GMT"));
  return Number.isNaN(parsed)
    ? undefined
    : new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Parses the single library index page into one record per model. */
export function parseLibrary(html) {
  const models = [];
  for (const [, slug, body] of html.matchAll(LIBRARY_ENTRY)) {
    const description = DESCRIPTION.exec(body);
    const pulls = PULLS.exec(body);
    const updated = UPDATED.exec(body);
    const updatedTitle = UPDATED_TITLE.exec(body);
    const model = {
      name: slug,
      description: description === null ? "" : text(description[1]),
      params: [...body.matchAll(CHIP)].map((chip) => text(chip[1])),
      pulls: pulls === null ? "" : text(pulls[1]),
      updated: updated === null ? "" : text(updated[1]),
    };
    const approx = approximatePulls(model.pulls);
    if (approx !== undefined) {
      model.pullsApprox = approx;
    }
    if (updatedTitle !== null) {
      const iso = parseUpdatedAt(updatedTitle[1]);
      if (iso !== undefined) {
        model.updatedAt = iso;
      }
    }
    models.push(model);
  }
  return models;
}

/**
 * Parses one model's tags page.
 *
 * Cloud tags are reported separately rather than mixed in: they host no
 * weights, so they have no size, no parameters, and no quantization. Emitting
 * them inside tags[] would put empty strings where every consumer expects a
 * size, which is why the reference artifact carries none.
 */
export function parseTags(html, model) {
  if (NO_MODELS.test(html) && !TAG_BODY.test(html)) {
    return { tags: [], cloudTags: [] };
  }
  const tags = [];
  const cloudTags = [];
  const seen = new Set();
  for (const [, reference, body] of html.matchAll(TAG_ROW)) {
    const separator = reference.indexOf(":");
    if (separator < 0 || reference.slice(0, separator) !== model) {
      // A "related models" link, not one of this model's tags.
      continue;
    }
    const tag = reference.slice(separator + 1);
    if (seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    const parsed = TAG_BODY.exec(unescapeHTML(body));
    if (parsed === null) {
      continue;
    }
    const [, digest, size, contextWindow] = parsed;
    const entry = {
      tag,
      digest: text(digest),
      size: text(size),
      contextWindow: text(contextWindow),
    };
    // Cloud rows render a usage band where a byte size would be.
    if (/usage/i.test(entry.size) || /(^|[-:])cloud$/.test(tag)) {
      cloudTags.push(entry);
      continue;
    }
    tags.push(entry);
  }
  return { tags, cloudTags };
}

/**
 * Parses a tag's detail page for the fields that exist nowhere else.
 *
 * Vision models render two metadata blocks: the model, then its projector
 * (always arch "clip"). The reference artifact concatenates them, which is why
 * it records bakllava as "7.24b312m" / "Q4_0F16". Here the model block is the
 * value and the projector is kept separately.
 */
export function parseDetail(html) {
  const fields = [...html.matchAll(DETAIL_FIELD)].map(([, key, value]) => [key, text(value)]);
  const blocks = [];
  for (const [key, value] of fields) {
    if (key === "arch" || blocks.length === 0) {
      blocks.push({});
    }
    blocks[blocks.length - 1][key] = value;
  }
  if (blocks.length === 0) {
    return undefined;
  }
  const [model, projector] = blocks;
  const info = {
    // Lowercased to match the reference's "20.9b"; quantization keeps the
    // source's casing, which is meaningful (Q4_0 and q4_0 both occur).
    parameters: (model.parameters ?? "").toLowerCase(),
    quantization: model.quantization ?? "",
  };
  if (model.arch !== undefined) {
    info.arch = model.arch;
  }
  if (projector !== undefined && projector.parameters !== undefined) {
    info.projector = {
      arch: projector.arch ?? "",
      parameters: projector.parameters.toLowerCase(),
      quantization: projector.quantization ?? "",
    };
  }
  return info;
}

/** The sentinel the reference uses for an unknown context window. */
export const UNKNOWN_CONTEXT = "N/A";

/**
 * Assembles the published artifact.
 *
 * detail maps `${model}@${digest}` to a parseDetail result, so tags sharing a
 * digest are fetched once. shapes maps the same keys to a parseGGUFShape
 * result; a tag without one (an MLX-format tag has no GGUF) simply has none.
 */
export function buildArtifact({ models, tagsByModel, detail, shapes = new Map(), generatedAt }) {
  const built = [];
  let tagCount = 0;
  let missingInfo = 0;
  let shapeCount = 0;
  for (const model of models) {
    const parsed = tagsByModel.get(model.name) ?? { tags: [], cloudTags: [] };
    const tags = parsed.tags.map((entry) => {
      const info = detail.get(`${model.name}@${entry.digest}`);
      tagCount += 1;
      if (info === undefined) {
        missingInfo += 1;
      }
      const modelInfo = {
        contextWindow: entry.contextWindow === "" ? UNKNOWN_CONTEXT : entry.contextWindow,
        parameters: info?.parameters ?? "",
        quantization: info?.quantization ?? "",
      };
      if (info?.arch !== undefined) {
        modelInfo.arch = info.arch;
      }
      if (info?.projector !== undefined) {
        modelInfo.projector = info.projector;
      }
      const shape = shapes.get(`${model.name}@${entry.digest}`);
      if (shape !== undefined) {
        shapeCount += 1;
        modelInfo.shape = { arch: shape.arch, ...shape.shape };
      }
      return { tag: entry.tag, size: entry.size, digest: entry.digest, model_info: modelInfo };
    });
    const record = {
      name: model.name,
      description: model.description,
      tags,
      params: model.params,
      pulls: model.pulls,
      updated: model.updated,
    };
    if (model.pullsApprox !== undefined) {
      record.pulls_approx = model.pullsApprox;
    }
    if (model.updatedAt !== undefined) {
      record.updated_at = model.updatedAt;
    }
    if (parsed.cloudTags.length > 0) {
      record.cloud = true;
      record.cloud_tags = parsed.cloudTags.map((entry) => entry.tag);
    }
    built.push(record);
  }
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    source: { url: LIBRARY_URL },
    counts: { models: built.length, tags: tagCount, missing_model_info: missingInfo, shapes: shapeCount },
    models: built,
  };
}

// Fields whose value is a scrape-time artifact rather than a fact about the
// model. They move on nearly every run, so change detection must ignore them or
// every refresh looks like a rewrite.
export const VOLATILE_FIELDS = ["pulls", "pulls_approx", "updated", "updated_at"];

/** Strips volatile fields so two runs can be compared for real change. */
export function stableView(artifact) {
  return artifact.models.map((model) => {
    const copy = { ...model };
    for (const field of VOLATILE_FIELDS) {
      delete copy[field];
    }
    return copy;
  });
}

/**
 * Guards a candidate artifact before it is published.
 *
 * The failure that matters is not one wrong value — it is a markup change that
 * hollows the file out while every request still returns 200. Coverage gates
 * catch that; nothing else does.
 */
export function checkGates({
  candidate,
  previous,
  minPopulated = 0.95,
  minCorpus = 0.9,
  // Looser than the rest: some tags genuinely publish no context window, and
  // Ollama could legitimately stop publishing more of them.
  minContext = 0.8,
} = {}) {
  const problems = [];
  const models = candidate.models;
  if (models.length === 0) {
    problems.push("candidate has no models");
    return problems;
  }

  const rate = (predicate) => models.filter(predicate).length / models.length;
  const fields = [
    ["description", (model) => model.description !== ""],
    ["params", (model) => model.params.length > 0],
    ["pulls", (model) => model.pulls !== ""],
    ["updated", (model) => model.updated !== ""],
  ];
  for (const [name, predicate] of fields) {
    const populated = rate(predicate);
    if (populated < minPopulated) {
      problems.push(
        `${name} populated on ${(populated * 100).toFixed(1)}% of models, floor ${(minPopulated * 100).toFixed(0)}%`,
      );
    }
  }

  // A model with no tags is legitimate only when it serves cloud tags instead.
  // Otherwise it is a tags page that failed to parse, which looks identical in
  // the published file and would quietly shrink the catalog.
  const hollow = models.filter((model) => model.tags.length === 0 && model.cloud !== true);
  if (hollow.length > 0) {
    problems.push(
      `${hollow.length} models have no tags and are not cloud-only: ${hollow.slice(0, 5).map((model) => model.name).join(", ")}`,
    );
  }

  const tags = models.flatMap((model) => model.tags);
  if (tags.length === 0) {
    problems.push("candidate has no tags");
  } else {
    // Every field a consumer reads gets a floor. A markup change usually breaks
    // one capture, not all of them, so a gate that scores only some of the
    // fields is a gate the next change walks past.
    const coverage = [
      ["size", (tag) => tag.size !== ""],
      ["parameters", (tag) => tag.model_info.parameters !== ""],
      ["quantization", (tag) => tag.model_info.quantization !== ""],
      // "N/A" is a legitimate value, but a selector break turns every tag into
      // one, so the floor here is loose enough for real gaps and tight enough
      // to catch a wholesale failure.
      ["contextWindow", (tag) => tag.model_info.contextWindow !== UNKNOWN_CONTEXT],
      // Scored only on tags with details: MLX-format tags have neither details
      // nor a GGUF to read a shape from. A shape is how Nexus judges memory fit.
      ["shape", (tag) => tag.model_info.parameters === "" || tag.model_info.shape !== undefined],
    ];
    for (const [name, predicate] of coverage) {
      const floor = name === "contextWindow" ? minContext : minPopulated;
      const populated = tags.filter(predicate).length / tags.length;
      if (populated < floor) {
        problems.push(
          `${name} populated on ${(populated * 100).toFixed(1)}% of tags, floor ${(floor * 100).toFixed(0)}%`,
        );
      }
    }
  }

  if (previous !== undefined && previous.models?.length > 0) {
    const ratio = models.length / previous.models.length;
    if (ratio < minCorpus) {
      problems.push(
        `model count fell to ${models.length} from ${previous.models.length} ` +
          `(${(ratio * 100).toFixed(1)}%, floor ${(minCorpus * 100).toFixed(0)}%)`,
      );
    }
    const previousTags = previous.models.flatMap((model) => model.tags).length;
    if (previousTags > 0 && tags.length / previousTags < minCorpus) {
      problems.push(`tag count fell to ${tags.length} from ${previousTags}`);
    }
  }
  return problems;
}

/**
 * Cross-checks scraped values against what the tag name implies.
 *
 * A tag named "8b-instruct-q4_K_M" states its own parameter size and
 * quantization. Agreement proves nothing on its own, but a sudden spike in
 * disagreement means the detail-page selector has drifted — the earliest
 * warning available, and it costs no requests.
 */
export function parameterCount(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmbt])?$/i.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const scale = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(match[2] ?? "b").toLowerCase()];
  return Number.parseFloat(match[1]) * scale;
}

// A name states a rounded size where the page reports the exact count: a tag
// named "20b" carries "20.9b". Only a gross disagreement is signal.
const DERIVATION_TOLERANCE = 0.25;

export function derivationMismatches(artifact) {
  const parameterFromName = /(?:^|-)(\d+(?:\.\d+)?)b(?![a-z0-9])/i;
  let checked = 0;
  let mismatched = 0;
  for (const model of artifact.models) {
    for (const tag of model.tags) {
      const derived = parameterFromName.exec(tag.tag);
      if (derived === null) {
        continue;
      }
      const actual = parameterCount(tag.model_info.parameters);
      const expected = parameterCount(`${derived[1]}b`);
      if (actual === undefined || expected === undefined) {
        continue;
      }
      checked += 1;
      if (Math.abs(actual - expected) / Math.max(actual, expected) > DERIVATION_TOLERANCE) {
        mismatched += 1;
      }
    }
  }
  return { checked, mismatched, rate: checked === 0 ? 0 : mismatched / checked };
}

function serializeModelInfo(info) {
  const parts = [];
  for (const key of ["contextWindow", "parameters", "quantization", "arch"]) {
    if (key in info) {
      parts.push(`${JSON.stringify(key)}:${JSON.stringify(info[key])}`);
    }
  }
  if (info.projector !== undefined) {
    parts.push(`"projector":${JSON.stringify(info.projector)}`);
  }
  if (info.shape !== undefined) {
    // Fixed key order, so a re-read that finds the same shape is not a diff.
    const ordered = { arch: info.shape.arch };
    for (const key of SHAPE_KEYS) {
      if (key in info.shape) {
        ordered[key] = info.shape[key];
      }
    }
    parts.push(`"shape":${JSON.stringify(ordered)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Renders the artifact with one line per tag and one line per model scalar.
 *
 * The shape is chosen for git rather than for looks. Pull counts move on almost
 * every model every run; with a whole model on one line that rewrites the file,
 * while one line per tag keeps a routine refresh to a handful of changed lines.
 */
export function serialize(artifact) {
  const lines = [
    "{",
    `  "schema_version": ${JSON.stringify(artifact.schema_version)},`,
    `  "generated_at": ${JSON.stringify(artifact.generated_at)},`,
    `  "source": ${JSON.stringify(artifact.source)},`,
    `  "counts": ${JSON.stringify(artifact.counts)},`,
    '  "models": [',
  ];
  artifact.models.forEach((model, modelIndex) => {
    lines.push("    {");
    lines.push(`      "name": ${JSON.stringify(model.name)},`);
    lines.push(`      "description": ${JSON.stringify(model.description)},`);
    lines.push('      "tags": [');
    model.tags.forEach((tag, tagIndex) => {
      const comma = tagIndex === model.tags.length - 1 ? "" : ",";
      lines.push(
        `        {"tag":${JSON.stringify(tag.tag)},"size":${JSON.stringify(tag.size)},` +
          `"digest":${JSON.stringify(tag.digest)},"model_info":${serializeModelInfo(tag.model_info)}}${comma}`,
      );
    });
    lines.push("      ],");
    lines.push(`      "params": ${JSON.stringify(model.params)},`);
    lines.push(`      "pulls": ${JSON.stringify(model.pulls)},`);
    if (model.pulls_approx !== undefined) {
      lines.push(`      "pulls_approx": ${JSON.stringify(model.pulls_approx)},`);
    }
    lines.push(`      "updated": ${JSON.stringify(model.updated)}${trailing(model)}`);
    if (model.updated_at !== undefined) {
      lines.push(`      "updated_at": ${JSON.stringify(model.updated_at)}${model.cloud === true ? "," : ""}`);
    }
    if (model.cloud === true) {
      lines.push('      "cloud": true,');
      lines.push(`      "cloud_tags": ${JSON.stringify(model.cloud_tags)}`);
    }
    lines.push(`    }${modelIndex === artifact.models.length - 1 ? "" : ","}`);
  });
  lines.push("  ]", "}");
  return `${lines.join("\n")}\n`;
}

function trailing(model) {
  return model.updated_at !== undefined || model.cloud === true ? "," : "";
}
