// Pure shaping and validation for v1/featured-models.json. No I/O, so every
// rule can be tested against fixtures; featured-generate.mjs does the fetching.
//
// Nothing here is typed from memory. Ollama tags, sizes, and context windows
// come from v1/ollama-models.json; Hugging Face repositories, GGUF file names,
// and byte counts come from the Hub API. A reference that cannot be confirmed
// is a problem, and a run with problems publishes nothing, because a featured
// row with a dead download behind it is worse than one fewer row.

export const SCHEMA_VERSION = 1;
export const TIERS = ["frontier", "excellent", "strong", "good"];
export const RUNTIMES = ["ollama", "llamacpp", "mlx"];
// Msty Nexus Cluster Advisor reads this collection by id.
export const CLUSTER_COLLECTION = "cluster";

// Roughly 2.8 bits per weight. Q3 and up clear it; IQ1 and IQ2 do not, and
// neither does anything that is not the weights at all.
const MIN_BYTES_PER_PARAMETER = 0.35;

const QUANT = /(?:^|[._-])(I?Q[1-8](?:_[A-Z0-9]+){0,3}|BF16|F16|F32|MXFP4)(?:[._-]|$)/i;
const SHARD = /-\d{5}-of-\d{5}/;
// A count in the publisher's repository name: Qwen3.5-397B-A17B.
const NAMED_PARAMETERS = /-(\d+(?:\.\d+)?)B(?:-A\d+(?:\.\d+)?B)?$/;

// Python's round(), which the original builder used: halves go to the even
// neighbour. Kept so the port labels "30.5b" as 30B, not 31B.
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * `4.9GB` as Ollama publishes it, in bytes; 0 when unreadable.
 *
 * A tag that resolves to different files per platform is published as a range,
 * "6.6GB - 7.6GB" (qwen3.5:9b is Q4_K_M on one platform and NVFP4 on another).
 * The upper end is used: size_bytes is what the download may cost, and a fit
 * check that overestimates by a gigabyte is safer than one that underestimates.
 */
export function parseSize(value) {
  const parts = String(value ?? "").split(/\s*-\s*/);
  const raw = parts[parts.length - 1].toUpperCase().replace(/\s/g, "");
  for (const [suffix, factor] of [["TB", 1e12], ["GB", 1e9], ["MB", 1e6], ["KB", 1e3], ["B", 1]]) {
    if (raw.endsWith(suffix)) {
      const number = Number.parseFloat(raw.slice(0, -suffix.length));
      return Number.isFinite(number) ? Math.round(number * factor) : 0;
    }
  }
  return 0;
}

/** `256K` or `1M` as Ollama publishes it, in tokens; 0 when unreadable. */
export function parseContext(value) {
  let raw = String(value ?? "").toUpperCase().replace(/\s/g, "");
  let multiplier = 1;
  if (raw.endsWith("M")) {
    multiplier = 1024 * 1024;
    raw = raw.slice(0, -1);
  } else if (raw.endsWith("K")) {
    multiplier = 1024;
    raw = raw.slice(0, -1);
  }
  const number = Number(raw);
  return raw !== "" && Number.isFinite(number) ? Math.round(number * multiplier) : 0;
}

/**
 * `8.03b` or `308m` as Ollama publishes it, rounded to something readable.
 *
 * Ollama reports sub-billion models in millions, and `1000m` for a model
 * everyone calls 1B. Both are normalized so a column of parameter counts can be
 * compared down the page.
 */
export function parametersLabel(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  const value = Number.parseFloat(text.slice(0, -1));
  if (!Number.isFinite(value)) return "";
  if (text.endsWith("m")) {
    return value >= 1000 ? parametersLabel(`${value / 1000}b`) : `${roundHalfEven(value)}M`;
  }
  if (!text.endsWith("b")) return "";
  if (value >= 10) return `${roundHalfEven(value)}B`;
  return `${value.toFixed(1)}B`.replace(".0B", "B");
}

/** The parameter count an Ollama tag publishes, as a number. */
export function parameterCount(tag) {
  const raw = String(tag?.model_info?.parameters ?? "").trim().toLowerCase();
  const scale = { b: 1e9, m: 1e6 }[raw.slice(-1)];
  const value = Number.parseFloat(raw.slice(0, -1));
  return scale && Number.isFinite(value) ? value * scale : 0;
}

const basename = (path) => path.slice(path.lastIndexOf("/") + 1);
const folder = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * The single GGUF a first-time download should get, or undefined.
 *
 * Three kinds of `.gguf` are not the model, and picking one produces a download
 * that completes and then does not work: `mmproj-*` is a vision projector,
 * `mtp-*` a multi-token-prediction draft head, `imatrix*` calibration data. A
 * `-00001-of-000NN` shard is one slice of a model this format cannot describe,
 * because a featured row promises one click. Undefined is a real answer: some
 * repositories publish only shards.
 */
export function pickGguf(files, parameters) {
  let ggufs = files.filter((entry) => {
    const name = basename(entry.path).toLowerCase();
    return name.endsWith(".gguf") && !name.startsWith("mmproj") && !name.startsWith("mtp-")
      && !name.includes("imatrix") && !SHARD.test(name);
  });
  // Bytes per parameter catches the oddities a name list has not met yet: a
  // projector, a calibration matrix, and a draft head all land far below any
  // real quantization, and so does a 1-bit quant nobody should get by default.
  if (parameters) {
    ggufs = ggufs.filter((entry) => entry.size / parameters >= MIN_BYTES_PER_PARAMETER);
  }
  if (ggufs.length === 0) return undefined;
  // Q4_K_M first: the quantization that trades the least quality for the most
  // size, and the one every other tool defaults to.
  for (const want of ["q4_k_m", "q4_k.", "q4_k_s", "mxfp4", "q4_0", "q8_0", "f16", "bf16"]) {
    const match = ggufs.find((entry) => basename(entry.path).toLowerCase().includes(want));
    if (match) return match;
  }
  return ggufs.reduce((smallest, entry) => (entry.size < smallest.size ? entry : smallest));
}

/**
 * The `mmproj-*` file that belongs beside the chosen weights, or undefined.
 *
 * The largest wins: a projector is a small fraction of the download, and the
 * quality lost by quantizing it is not worth the megabytes saved. Repositories
 * that sort quantizations into folders keep the matching projector in the same
 * folder or at the root.
 */
export function pickProjector(files, weights) {
  const directory = folder(weights.path);
  const projectors = files.filter((entry) => {
    const name = basename(entry.path).toLowerCase();
    if (!name.startsWith("mmproj") || !name.endsWith(".gguf")) return false;
    return !directory || [directory, ""].includes(folder(entry.path));
  });
  if (projectors.length === 0) return undefined;
  return projectors.reduce((largest, entry) => (entry.size > largest.size ? entry : largest));
}

/** Indexes v1/ollama-models.json by `model:tag`. */
export function indexOllama(catalog) {
  const index = new Map();
  for (const model of catalog.models) {
    for (const tag of model.tags) index.set(`${model.name}:${tag.tag}`, tag);
  }
  return index;
}

/** Every Hugging Face repository the curation names, for the fetcher. */
export function hubReferences(curation) {
  const repos = new Set();
  const bases = new Set();
  const configs = new Set();
  for (const model of curation.models) {
    for (const repo of [model.gguf, model.mlx]) if (repo) repos.add(repo);
    if (!model.ollama && model.base) {
      if (!NAMED_PARAMETERS.test(model.base)) bases.add(model.base);
      if (model.mlx) configs.add(model.mlx);
    }
  }
  return { repos: [...repos].sort(), bases: [...bases].sort(), configs: [...configs].sort() };
}

/** Problems with the curated input itself, before anything is fetched. */
export function validateCuration(curation) {
  const problems = [];
  const ids = new Set();
  for (const model of curation.models) {
    if (!model.id || !model.name) problems.push(`a curated model has no id or name`);
    if (ids.has(model.id)) problems.push(`${model.id}: curated twice`);
    ids.add(model.id);
    if (!TIERS.includes(model.tier)) problems.push(`${model.id}: tier ${JSON.stringify(model.tier)} is not one of ${TIERS.join(", ")}`);
    if (!model.ollama && !model.gguf && !model.mlx) problems.push(`${model.id}: names no install`);
    if (!model.ollama && !model.base) problems.push(`${model.id}: no ollama tag and no base repository`);
  }
  for (const collection of curation.collections) {
    const missing = collection.models.filter((id) => !ids.has(id));
    if (missing.length > 0) problems.push(`collection ${collection.id}: unresolved ${missing.join(", ")}`);
    if (collection.models.length === 0) problems.push(`collection ${collection.id}: empty`);
  }
  if (!curation.collections.some((collection) => collection.id === CLUSTER_COLLECTION)) {
    problems.push(`no ${CLUSTER_COLLECTION} collection`);
  }
  return problems;
}

/**
 * Builds the artifact from the curation and what the fetcher read.
 *
 * hub.trees, hub.stats, hub.bases, and hub.configs map a repository to its
 * file list, {downloads, likes}, model document, and config.json; a missing or
 * null entry means it could not be read. Returns the artifact, the problems
 * that must block publishing, and notes that do not.
 */
export function buildArtifact({ curation, ollama, hub, generatedAt }) {
  const problems = validateCuration(curation);
  const notes = [];
  const models = [];

  for (const entry of curation.models) {
    const capabilities = [...entry.capabilities];
    const installs = [];
    let parameters = "";
    let context = 0;
    let downloads = 0;
    let likes = 0;

    const tag = entry.ollama ? ollama.get(entry.ollama) : undefined;
    if (entry.ollama && !tag) {
      problems.push(`${entry.id}: ollama tag ${entry.ollama} is not in the catalog`);
    } else if (tag) {
      const info = tag.model_info ?? {};
      parameters = parametersLabel(info.parameters);
      context = parseContext(info.contextWindow);
      const install = { runtime: "ollama", model: entry.ollama.replace(/:latest$/, "") };
      const size = parseSize(tag.size);
      // A size the parser cannot read is a parser bug, not a missing value:
      // Ollama renders one for every downloadable tag.
      if (size) install.size_bytes = size;
      else problems.push(`${entry.id}: ollama size ${JSON.stringify(tag.size)} is unreadable`);
      if (info.quantization) install.quantization = info.quantization;
      installs.push(install);
    } else if (entry.base) {
      const named = NAMED_PARAMETERS.exec(entry.base);
      // A count in the repository name wins over the Hub's safetensors total,
      // which also counts vision and MTP weights and so would label the row
      // with a size nobody calls the model.
      const total = named ? Number(named[1]) * 1e9 : hub.bases.get(entry.base)?.safetensors?.total ?? 0;
      const config = hub.configs.get(entry.mlx) ?? {};
      context = config.max_position_embeddings ?? config.text_config?.max_position_embeddings ?? 0;
      if (!total || !context) {
        problems.push(`${entry.id}: parameters or context unreadable from ${entry.base} and ${entry.mlx}`);
      }
      parameters = total ? parametersLabel(`${total / 1e9}b`) : "";
    }

    const popularity = (repo) => {
      const stats = hub.stats.get(repo);
      if (!stats) {
        // Popularity is decoration, so a stats hiccup never blocks a build.
        notes.push(`${entry.id}: ${repo} stats are unreadable, so it ships without numbers`);
        return;
      }
      downloads = Math.max(downloads, stats.downloads);
      likes = Math.max(likes, stats.likes);
    };

    if (entry.gguf) {
      const files = hub.trees.get(entry.gguf);
      if (!files) {
        problems.push(`${entry.id}: gguf repo ${entry.gguf} is unreachable`);
      } else {
        popularity(entry.gguf);
        const chosen = pickGguf(files, parameterCount(tag));
        if (!chosen) {
          notes.push(`${entry.id}: ${entry.gguf} publishes only sharded weights, so it gets no llama.cpp variant`);
        } else {
          const quantization = QUANT.exec(chosen.path);
          const projector = pickProjector(files, chosen);
          installs.push({
            runtime: "llamacpp",
            repository: entry.gguf,
            file: chosen.path,
            ...(quantization ? { quantization: quantization[1].toUpperCase() } : {}),
            // The projector is part of the download, so it is part of the size.
            size_bytes: chosen.size + (projector ? projector.size : 0),
            ...(projector ? { projector: projector.path } : {}),
          });
          // A publisher shipping a projector is stating the model is
          // multimodal, which is better evidence than a curator's memory.
          if (projector && !capabilities.includes("vision")) capabilities.push("vision");
          if (capabilities.includes("vision") && !projector) {
            problems.push(`${entry.id}: ${entry.gguf} has no mmproj beside ${chosen.path}, so llama.cpp could not see`);
          }
        }
      }
    }

    if (entry.mlx) {
      const files = hub.trees.get(entry.mlx);
      if (!files) {
        problems.push(`${entry.id}: mlx repo ${entry.mlx} is unreachable`);
      } else {
        popularity(entry.mlx);
        // A snapshot pull downloads the whole repository.
        installs.push({ runtime: "mlx", repository: entry.mlx, size_bytes: files.reduce((sum, file) => sum + file.size, 0) });
      }
    }

    if (installs.length === 0) {
      problems.push(`${entry.id}: no usable install`);
      continue;
    }

    const model = { id: entry.id, name: entry.name, publisher: entry.publisher, summary: entry.summary };
    if (parameters) model.parameters = parameters;
    if (context) model.context = context;
    // The per-field maximum across the model's repositories. Nexus refreshes
    // these live; the published numbers are only the fallback.
    if (downloads) model.downloads = downloads;
    if (likes) model.likes = likes;
    model.capabilities = capabilities;
    if (entry.coding) model.tags = ["coding"];
    model.tier = entry.tier;
    model.installs = installs;
    models.push(model);
  }

  const known = new Set(models.map((model) => model.id));
  const collections = curation.collections.map((collection) => ({
    id: collection.id,
    title: collection.title,
    description: collection.description,
    models: collection.models.filter((id) => known.has(id)),
  }));

  return {
    artifact: { schema_version: SCHEMA_VERSION, generated_at: generatedAt, collections, models },
    problems: [...new Set(problems)],
    notes,
  };
}

/**
 * The artifact without the fields that move on their own. generated_at moves
 * every run, and popularity every day; neither is a reason to publish, so the
 * history keeps meaning "the featured list changed".
 */
export function stableView(artifact) {
  return {
    collections: artifact.collections,
    models: artifact.models.map(({ downloads, likes, ...rest }) => rest),
  };
}

export function serialize(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/**
 * Problems with a published artifact, without the network: its shape, and
 * whether it still matches the curation (a curation edit without a rebuild
 * fails here).
 */
export function validateFeatured(artifact, curation) {
  const problems = [];
  if (artifact.schema_version !== SCHEMA_VERSION) problems.push(`schema_version is not ${SCHEMA_VERSION}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(artifact.generated_at ?? "")) {
    problems.push("generated_at is not an RFC 3339 UTC timestamp");
  }

  const byId = new Map(artifact.models.map((model) => [model.id, model]));
  const curated = new Map(curation.models.map((model) => [model.id, model]));
  if (byId.size !== artifact.models.length) problems.push("model ids are not unique");
  const order = (list) => JSON.stringify(list.map((model) => model.id));
  if (order(artifact.models) !== order(curation.models)) {
    problems.push("models differ from the curation; rebuild with scripts/featured-generate.mjs");
  }

  for (const model of artifact.models) {
    const want = curated.get(model.id);
    if (!want) continue;
    for (const field of ["name", "publisher", "summary", "tier"]) {
      if (model[field] !== want[field]) problems.push(`${model.id}: ${field} differs from the curation`);
    }
    if (JSON.stringify(model.tags) !== JSON.stringify(want.coding ? ["coding"] : undefined)) {
      problems.push(`${model.id}: tags differ from the curation`);
    }
    if (!want.capabilities.every((capability) => model.capabilities?.includes(capability))) {
      problems.push(`${model.id}: capabilities differ from the curation`);
    }
    if (!Array.isArray(model.installs) || model.installs.length === 0) {
      problems.push(`${model.id}: no installs`);
      continue;
    }
    for (const install of model.installs) {
      if (!RUNTIMES.includes(install.runtime)) problems.push(`${model.id}: unknown runtime ${install.runtime}`);
      if (install.runtime === "ollama" && !install.model) problems.push(`${model.id}: ollama install has no tag`);
      if (install.runtime !== "ollama" && !install.repository) problems.push(`${model.id}: ${install.runtime} install has no repository`);
      if (install.runtime === "llamacpp" && !install.file) problems.push(`${model.id}: llama.cpp install has no file`);
      if (!Number.isSafeInteger(install.size_bytes) || install.size_bytes <= 0) {
        problems.push(`${model.id}: ${install.runtime} install has no size`);
      }
    }
    const repos = (runtime) => model.installs.filter((install) => install.runtime === runtime).map((install) => install.repository ?? install.model);
    if (want.mlx && !repos("mlx").includes(want.mlx)) problems.push(`${model.id}: mlx install is not ${want.mlx}`);
    if (want.ollama && !repos("ollama").includes(want.ollama.replace(/:latest$/, ""))) {
      problems.push(`${model.id}: ollama install is not ${want.ollama}`);
    }
  }

  const wantCollections = curation.collections.map(({ id, title, description, models }) => ({ id, title, description, models }));
  if (JSON.stringify(artifact.collections) !== JSON.stringify(wantCollections)) {
    problems.push("collections differ from the curation; rebuild with scripts/featured-generate.mjs");
  }
  const cluster = artifact.collections.find((collection) => collection.id === CLUSTER_COLLECTION);
  for (const id of cluster?.models ?? []) {
    if (!byId.get(id)?.installs?.some((install) => install.runtime === "mlx")) {
      problems.push(`${id}: in the ${CLUSTER_COLLECTION} collection without an mlx install`);
    }
  }
  return problems;
}
