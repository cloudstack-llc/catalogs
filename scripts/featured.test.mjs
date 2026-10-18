import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { COLLECTIONS, MODELS } from "./featured-curation.mjs";
import {
  buildArtifact,
  parametersLabel,
  parseSize,
  pickGguf,
  stableView,
  validateCuration,
  validateFeatured,
} from "./featured.mjs";

const GB = 1e9;

function curation() {
  return {
    models: [
      {
        id: "small", name: "Small", publisher: "P", summary: "S.", capabilities: ["chat"],
        ollama: "small:8b", gguf: "org/Small-GGUF", mlx: "mlx-community/Small-4bit", tier: "good", coding: true,
      },
      {
        id: "huge", name: "Huge", publisher: "P", summary: "S.", capabilities: ["chat"],
        mlx: "mlx-community/Huge-4bit", base: "org/Huge-400B-A20B", tier: "frontier",
      },
    ],
    collections: [
      { id: "start-here", title: "Start", description: "D.", models: ["small"] },
      { id: "cluster", title: "Cluster", description: "D.", models: ["huge"] },
    ],
  };
}

function inputs() {
  return {
    curation: curation(),
    ollama: new Map([["small:8b", { size: "4.9GB - 5.2GB", model_info: { parameters: "8.19b", contextWindow: "40K", quantization: "Q4_K_M" } }]]),
    hub: {
      trees: new Map([
        ["org/Small-GGUF", [
          { path: "Small-Q4_K_M.gguf", size: 5 * GB },
          { path: "Small-Q8_0.gguf", size: 9 * GB },
          { path: "mmproj-F16.gguf", size: 0.6 * GB },
        ]],
        ["mlx-community/Small-4bit", [{ path: "model.safetensors", size: 4 * GB }, { path: "config.json", size: 1000 }]],
        ["mlx-community/Huge-4bit", [{ path: "model-00001-of-00002.safetensors", size: 100 * GB }, { path: "model-00002-of-00002.safetensors", size: 120 * GB }]],
      ]),
      stats: new Map([["org/Small-GGUF", { downloads: 10, likes: 2 }], ["mlx-community/Small-4bit", { downloads: 5, likes: 7 }]]),
      bases: new Map(),
      configs: new Map([["mlx-community/Huge-4bit", { text_config: { max_position_embeddings: 262144 } }]]),
    },
    generatedAt: "2026-10-18T00:00:00Z",
  };
}

test("an Ollama size published as a range uses the upper end", () => {
  assert.equal(parseSize("6.6GB - 7.6GB"), 7.6 * GB);
  assert.equal(parseSize("14GB"), 14 * GB);
  assert.equal(parseSize("523MB"), 523e6);
  assert.equal(parseSize("N/A"), 0);
});

test("parameter labels match the original builder's rounding", () => {
  assert.equal(parametersLabel("8.95b"), "8.9B");
  assert.equal(parametersLabel("30.5b"), "30B");
  assert.equal(parametersLabel("1000m"), "1B");
  assert.equal(parametersLabel("752m"), "752M");
});

test("the GGUF pick skips projectors, shards, draft heads, and too-small files", () => {
  const files = [
    { path: "mmproj-F16.gguf", size: 0.6 * GB },
    { path: "mtp-Q4_K_M.gguf", size: 0.2 * GB },
    { path: "M-Q4_K_M-00001-of-00002.gguf", size: 3 * GB },
    { path: "M-IQ1_S.gguf", size: 1.5 * GB },
    { path: "M-Q8_0.gguf", size: 9 * GB },
  ];
  assert.equal(pickGguf(files, 8 * GB).path, "M-Q8_0.gguf");
  assert.equal(pickGguf(files.slice(0, 3), 8 * GB), undefined);
});

test("builds rows from Ollama and from the Hub, with tier, tags, and a projector", () => {
  const { artifact, problems } = buildArtifact(inputs());
  assert.deepEqual(problems, []);
  const [small, huge] = artifact.models;
  assert.equal(small.parameters, "8.2B");
  assert.equal(small.context, 40960);
  assert.deepEqual(small.tags, ["coding"]);
  assert.equal(small.tier, "good");
  assert.deepEqual(small.capabilities, ["chat", "vision"]);
  assert.deepEqual(small.installs.map((install) => install.size_bytes), [5.2 * GB, 5.6 * GB, 4 * GB + 1000]);
  assert.equal(small.installs[1].projector, "mmproj-F16.gguf");
  assert.equal(small.downloads, 10);
  assert.equal(small.likes, 7);
  assert.equal(huge.parameters, "400B");
  assert.equal(huge.context, 262144);
  assert.equal(huge.tier, "frontier");
  assert.deepEqual(huge.installs, [{ runtime: "mlx", repository: "mlx-community/Huge-4bit", size_bytes: 220 * GB }]);
});

test("an unconfirmed reference or an unreadable size blocks publishing", () => {
  const unreadable = inputs();
  unreadable.ollama.get("small:8b").size = "about five gigs";
  assert.match(buildArtifact(unreadable).problems.join("\n"), /ollama size .* is unreadable/);

  const missingTag = inputs();
  missingTag.ollama.clear();
  assert.match(buildArtifact(missingTag).problems.join("\n"), /not in the catalog/);

  const deadRepo = inputs();
  deadRepo.hub.trees.set("mlx-community/Huge-4bit", null);
  assert.match(buildArtifact(deadRepo).problems.join("\n"), /Huge-4bit is unreachable/);

  const noContext = inputs();
  noContext.hub.configs.clear();
  assert.match(buildArtifact(noContext).problems.join("\n"), /parameters or context unreadable/);
});

test("a stats failure is a note, never a problem", () => {
  const input = inputs();
  input.hub.stats.clear();
  const { problems, notes } = buildArtifact(input);
  assert.deepEqual(problems, []);
  assert.equal(notes.length, 3);
});

test("the curation rejects bad tiers, dangling references, and a missing cluster collection", () => {
  const bad = curation();
  bad.models[0].tier = "great";
  bad.collections = [{ id: "start-here", title: "S", description: "D.", models: ["small", "gone"] }];
  const problems = validateCuration(bad).join("\n");
  assert.match(problems, /tier "great"/);
  assert.match(problems, /unresolved gone/);
  assert.match(problems, /no cluster collection/);
});

test("popularity and generated_at alone do not count as a change", () => {
  const first = buildArtifact(inputs()).artifact;
  const later = inputs();
  later.generatedAt = "2026-10-19T00:00:00Z";
  later.hub.stats.set("org/Small-GGUF", { downloads: 999, likes: 99 });
  assert.deepEqual(stableView(buildArtifact(later).artifact), stableView(first));
});

test("the published file must match the curation", () => {
  const { artifact } = buildArtifact(inputs());
  assert.deepEqual(validateFeatured(artifact, curation()), []);
  const edited = curation();
  edited.models[1].tier = "excellent";
  assert.match(validateFeatured(artifact, edited).join("\n"), /huge: tier differs/);
});

test("the committed featured list is valid and matches the curation", async () => {
  const committed = JSON.parse(await readFile(new URL("../v1/featured-models.json", import.meta.url), "utf8"));
  const real = { models: MODELS, collections: COLLECTIONS };
  assert.deepEqual(validateCuration(real), []);
  assert.deepEqual(validateFeatured(committed, real), []);
});
