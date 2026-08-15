// Run: node --test scripts/*.test.mjs
//
// Fixtures are trimmed from real ollama.com responses, so a markup change that
// would break the generator breaks these first.

import assert from "node:assert/strict";
import test from "node:test";

import {
  approximatePulls,
  buildArtifact,
  checkGates,
  derivationMismatches,
  parseDetail,
  parseLibrary,
  parseTags,
  parseUpdatedAt,
  serialize,
  stableView,
} from "./ollama.mjs";

const libraryEntry = (slug, { chips = "", pulls = "5M", updated = "1 month ago" } = {}) => `
<li  class="flex items-baseline border-b border-neutral-200 py-6">
  <a href="/library/${slug}" class="group w-full">
    <h2><span>${slug}</span></h2>
    <p class="max-w-lg break-words text-neutral-800 text-md">OpenAI&#39;s open-weight models.</p>
    ${chips}
    <p class="flex space-x-5">
      <span class="flex items-center">
        <svg><path d="M3 16.5v2.25A2.25 2.25 0 0 0 5 21"></path></svg>
        <span >${pulls}</span>
      </span>
      <span class="flex items-center" title="Nov 30, 2024 10:34 PM UTC">
        <svg><path d="M12 6v6h4.5"></path></svg>
        <span class="hidden sm:flex">Updated&nbsp;</span>
        <span >${updated}</span>
      </span>
    </p>
  </a>
</li>`;

const chip = (label, colour) =>
  `<span  class="inline-flex items-center rounded-md bg-${colour === "size" ? "\[#ddf4ff\]" : colour === "cloud" ? "cyan-50" : "indigo-50"} px-2 py-0.5 text-xs font-medium text-${colour === "size" ? "blue-600" : colour === "cloud" ? "cyan-500" : "indigo-600"} sm:text-[13px]">${label}</span>`;

test("parses the library index into one record per model", () => {
  const html = libraryEntry("gpt-oss", {
    chips: [chip("tools", "cap"), chip("thinking", "cap"), chip("cloud", "cloud"), chip("20b", "size")].join(""),
    pulls: "11.8M",
  });
  const [model] = parseLibrary(html);
  assert.equal(model.name, "gpt-oss");
  // The curly apostrophe must survive entity decoding.
  assert.equal(model.description, "OpenAI's open-weight models.");
  assert.deepEqual(model.params, ["tools", "thinking", "cloud", "20b"]);
  assert.equal(model.pulls, "11.8M");
  assert.equal(model.pullsApprox, 11_800_000);
  assert.equal(model.updated, "1 month ago");
  assert.equal(model.updatedAt, "2024-11-30T22:34:00Z");
});

test("a model missing optional chrome still parses", () => {
  const html = `
<li  class="flex items-baseline border-b border-neutral-200 py-6">
  <a href="/library/bare"><h2>bare</h2></a>
</li>`;
  const [model] = parseLibrary(html);
  assert.deepEqual(
    { name: model.name, description: model.description, params: model.params, pulls: model.pulls },
    { name: "bare", description: "", params: [], pulls: "" },
  );
  assert.equal("pullsApprox" in model, false);
});

test("decodes humanized pull counts and refuses nonsense", () => {
  assert.equal(approximatePulls("5M"), 5_000_000);
  assert.equal(approximatePulls("11.8M"), 11_800_000);
  assert.equal(approximatePulls("145K"), 145_000);
  assert.equal(approximatePulls("1,234"), 1234);
  assert.equal(approximatePulls("2.1B"), 2_100_000_000);
  assert.equal(approximatePulls("lots"), undefined);
  assert.equal(approximatePulls(""), undefined);
});

test("parses the absolute updated timestamp, and tolerates a broken one", () => {
  assert.equal(parseUpdatedAt("Nov 30, 2024 10:34 PM UTC"), "2024-11-30T22:34:00Z");
  assert.equal(parseUpdatedAt("not a date"), undefined);
});

// The live markup uses a literal bullet, a leading space inside the digest
// span, and a nested span for the input modality.
const tagRow = (reference, digest, size, context) => `
<a href="/library/${reference}" class="md:hidden flex flex-col space-y-[6px] group">
  <div class="flex flex-col text-neutral-500 text-[13px]"><span>
    <span class="font-mono"> ${digest}</span> \u2022 ${size} \u2022 ${context} context window \u2022
    <span class="hidden sm:inline"> Text input \u2022 10 months ago </span>
  </span></div>
</a>`;

test("parses tags from the mobile block and separates cloud rows", () => {
  const html = [
    tagRow("gpt-oss:latest", "17052f91a42e", "14GB", "128K"),
    tagRow("gpt-oss:20b", "17052f91a42e", "14GB", "128K"),
    tagRow("gpt-oss:120b-cloud", "06daa293c105", "Medium Usage", "200K"),
    // A "related models" link must not be adopted as one of this model's tags.
    tagRow("llama3.1:8b", "aaaaaaaaaaaa", "4.9GB", "128K"),
  ].join("");
  const { tags, cloudTags } = parseTags(html, "gpt-oss");
  assert.deepEqual(tags.map((tag) => tag.tag), ["latest", "20b"]);
  assert.deepEqual(tags[0], {
    tag: "latest", digest: "17052f91a42e", size: "14GB", contextWindow: "128K",
  });
  assert.deepEqual(cloudTags.map((tag) => tag.tag), ["120b-cloud"]);
});

test("a cloud-only model reports no tags rather than failing", () => {
  const { tags, cloudTags } = parseTags('<div class="...">No models</div>', "glm-4.6");
  assert.deepEqual(tags, []);
  assert.deepEqual(cloudTags, []);
});

const detailBlock = (arch, parameters, quantization) =>
  `<div class="flex sm:space-x-2 items-center"><span class="hidden sm:block">arch</span><span class="text-neutral-400 sm:font-semibold sm:text-neutral-800 sm:text-xs">${arch}</span></div>` +
  `<div class="flex sm:space-x-2 items-center"><span class="hidden sm:block">parameters</span><span class="text-neutral-400 sm:font-semibold sm:text-neutral-800 sm:text-xs">${parameters}</span></div>` +
  `<div class="flex sm:space-x-2 items-center"><span class="hidden sm:block">quantization</span><span class="text-neutral-400 sm:font-semibold sm:text-neutral-800 sm:text-xs">${quantization}</span></div>`;

test("parses a detail page and lowercases only the parameter count", () => {
  const info = parseDetail(detailBlock("gptoss", "20.9B", "MXFP4"));
  assert.deepEqual(info, { parameters: "20.9b", quantization: "MXFP4", arch: "gptoss" });
});

test("keeps a vision model's projector out of its model_info", () => {
  // The reference artifact concatenates these into "7.24b312m" / "Q4_0F16".
  const info = parseDetail(detailBlock("llama", "7.24B", "Q4_0") + detailBlock("clip", "312M", "F16"));
  assert.equal(info.parameters, "7.24b");
  assert.equal(info.quantization, "Q4_0");
  assert.deepEqual(info.projector, { arch: "clip", parameters: "312m", quantization: "F16" });
});

test("README prose after the metadata block does not leak into the values", () => {
  const html = detailBlock("gptoss", "20.9B", "MXFP4") + "<h3>Quantization - MXFP4 format</h3><p>quantization notes</p>";
  assert.deepEqual(parseDetail(html), { parameters: "20.9b", quantization: "MXFP4", arch: "gptoss" });
});

test("a page with no metadata block yields nothing", () => {
  assert.equal(parseDetail("<html><body>nothing here</body></html>"), undefined);
});

function sampleArtifact() {
  const models = parseLibrary(
    libraryEntry("gpt-oss", { chips: chip("tools", "cap"), pulls: "11.8M" }) + libraryEntry("llava", { chips: [chip("vision", "cap"), chip("13b", "size")].join(""), pulls: "2M" }),
  );
  const tagsByModel = new Map([
    ["gpt-oss", parseTags(tagRow("gpt-oss:20b", "aaa111", "14GB", "128K") + tagRow("gpt-oss:120b-cloud", "bbb222", "Medium Usage", "200K"), "gpt-oss")],
    ["llava", parseTags(tagRow("llava:13b", "ccc333", "8.0GB", "32K"), "llava")],
  ]);
  const detail = new Map([
    ["gpt-oss@aaa111", { parameters: "20.9b", quantization: "MXFP4", arch: "gptoss" }],
    ["llava@ccc333", { parameters: "13b", quantization: "Q4_0", arch: "llama", projector: { arch: "clip", parameters: "312m", quantization: "F16" } }],
  ]);
  return buildArtifact({ models, tagsByModel, detail, generatedAt: "2026-08-15T00:00:00Z" });
}

test("builds an artifact in the published shape", () => {
  const artifact = sampleArtifact();
  assert.equal(artifact.counts.models, 2);
  assert.equal(artifact.counts.tags, 2);
  assert.equal(artifact.counts.missing_model_info, 0);

  const [gptOss, llava] = artifact.models;
  // Every field the consuming schema requires is present on every model.
  for (const model of artifact.models) {
    for (const field of ["name", "description", "tags", "params", "pulls", "updated"]) {
      assert.ok(field in model, `${model.name} is missing ${field}`);
    }
  }
  assert.deepEqual(gptOss.tags[0].model_info, {
    contextWindow: "128K", parameters: "20.9b", quantization: "MXFP4", arch: "gptoss",
  });
  // The cloud tag is recorded on the model, not mixed into tags[].
  assert.equal(gptOss.tags.length, 1);
  assert.equal(gptOss.cloud, true);
  assert.deepEqual(gptOss.cloud_tags, ["120b-cloud"]);
  assert.equal("cloud" in llava, false);
  assert.deepEqual(llava.tags[0].model_info.projector, {
    arch: "clip", parameters: "312m", quantization: "F16",
  });
});

test("an unknown context window uses the reference sentinel, never an empty string", () => {
  const models = parseLibrary(libraryEntry("m"));
  const tagsByModel = new Map([["m", { tags: [{ tag: "latest", digest: "d", size: "1GB", contextWindow: "" }], cloudTags: [] }]]);
  const artifact = buildArtifact({ models, tagsByModel, detail: new Map(), generatedAt: "2026-08-15T00:00:00Z" });
  assert.equal(artifact.models[0].tags[0].model_info.contextWindow, "N/A");
  assert.equal(artifact.counts.missing_model_info, 1);
});

test("serializes to valid JSON with one line per tag", () => {
  const artifact = sampleArtifact();
  const text = serialize(artifact);
  assert.deepEqual(JSON.parse(text), artifact);
  assert.match(text, /\n {8}\{"tag":"20b","size":"14GB"/);
  assert.equal(text.endsWith("}\n"), true);
  // Byte-stable across runs, so a diff shows only what moved.
  assert.equal(serialize(JSON.parse(text)), text);
});

test("stableView hides the fields that move on every run", () => {
  const artifact = sampleArtifact();
  const before = stableView(artifact);
  artifact.models[0].pulls = "12M";
  artifact.models[0].pulls_approx = 12_000_000;
  artifact.models[0].updated = "2 months ago";
  assert.deepEqual(stableView(artifact), before, "a pull-count move must not read as a real change");
  artifact.models[0].description = "changed";
  assert.notDeepEqual(stableView(artifact), before);
});

test("gates reject a hollowed-out catalog", () => {
  const artifact = sampleArtifact();
  assert.deepEqual(checkGates({ candidate: artifact }), []);

  assert.deepEqual(checkGates({ candidate: { models: [] } }), ["candidate has no models"]);

  // A markup change that empties one field still returns 200 on every request.
  const hollow = JSON.parse(JSON.stringify(artifact));
  for (const model of hollow.models) {
    model.description = "";
  }
  assert.equal(checkGates({ candidate: hollow }).some((p) => p.startsWith("description")), true);

  const noTags = JSON.parse(JSON.stringify(artifact));
  for (const model of noTags.models) {
    model.tags = [];
  }
  assert.equal(checkGates({ candidate: noTags }).includes("candidate has no tags"), true);

  const shrunk = JSON.parse(JSON.stringify(artifact));
  shrunk.models = shrunk.models.slice(0, 1);
  const previous = { models: [...artifact.models, ...artifact.models, ...artifact.models] };
  assert.equal(checkGates({ candidate: shrunk, previous }).some((p) => p.startsWith("model count fell")), true);

  // Growth is expected and must never fail the run.
  assert.deepEqual(checkGates({ candidate: artifact, previous: { models: [artifact.models[0]] } }), []);
});

test("gates catch missing per-tag metadata", () => {
  const models = parseLibrary(libraryEntry("m"));
  const tagsByModel = new Map([["m", { tags: [{ tag: "8b", digest: "d", size: "4GB", contextWindow: "8K" }], cloudTags: [] }]]);
  const artifact = buildArtifact({ models, tagsByModel, detail: new Map(), generatedAt: "2026-08-15T00:00:00Z" });
  assert.equal(checkGates({ candidate: artifact }).some((p) => p.startsWith("parameters")), true);
});

test("the derivation canary agrees with correctly scraped values", () => {
  const artifact = sampleArtifact();
  // "20b" in the tag name against "20.9b" scraped is the same model stated two
  // ways, and must not read as drift.
  assert.deepEqual(derivationMismatches(artifact), { checked: 2, mismatched: 0, rate: 0 });

  const drifted = JSON.parse(JSON.stringify(artifact));
  // The projector's count where the model's belongs: gross, and caught.
  drifted.models[0].tags[0].model_info.parameters = "312m";
  assert.equal(derivationMismatches(drifted).mismatched, 1);
});
