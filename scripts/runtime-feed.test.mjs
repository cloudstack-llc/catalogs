import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  REQUIRED_LLAMACPP_VARIANTS,
  buildRuntimeFeed,
  resolveStableLlamaRelease,
  signRuntimeFeed,
  validateRuntimeFeed,
  verifySignedRuntimeFeed,
} from "./runtime-feed-lib.mjs";

const sha = (character) => character.repeat(64);
const githubAsset = (repo, tag, name, character = "a", size = 10) => ({
  name,
  size,
  digest: `sha256:${sha(character)}`,
  browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
});

function llamaAssets(tag) {
  const build = tag.slice(1);
  return [
    `llama-b${build}-bin-macos-arm64.tar.gz`,
    `llama-b${build}-bin-ubuntu-x64.tar.gz`,
    `llama-b${build}-bin-ubuntu-rocm-7.0-x64.tar.gz`,
    `llama-b${build}-bin-ubuntu-vulkan-x64.tar.gz`,
    `llama-b${build}-bin-ubuntu-sycl-fp32-x64.tar.gz`,
    `llama-b${build}-bin-ubuntu-arm64.tar.gz`,
    `llama-b${build}-bin-ubuntu-vulkan-arm64.tar.gz`,
    `llama-b${build}-bin-win-cpu-x64.zip`,
    `llama-b${build}-bin-win-cuda-12.4-x64.zip`,
    "cudart-llama-bin-win-cuda-12.4-x64.zip",
    `llama-b${build}-bin-win-rocm-7.0-x64.zip`,
    `llama-b${build}-bin-win-vulkan-x64.zip`,
    `llama-b${build}-bin-win-sycl-x64.zip`,
    `llama-b${build}-bin-win-cpu-arm64.zip`,
  ].map((name, index) => githubAsset("ggml-org/llama.cpp", tag, name, "b", index + 1));
}

function fixtureGitHub() {
  const ollamaTag = "v1.2.3";
  const llamaTag = "b1234";
  const ollamaNames = [
    "ollama-darwin.tgz",
    "ollama-linux-amd64.tar.zst",
    "ollama-linux-arm64.tar.zst",
    "ollama-windows-amd64.zip",
    "ollama-windows-arm64.zip",
  ];
  const ollama = {
    tag_name: ollamaTag,
    draft: false,
    prerelease: false,
    assets: ollamaNames.map((name, index) => githubAsset("ollama/ollama", ollamaTag, name, "a", index + 1)),
  };
  const stable = {
    tag_name: "v0.3.0",
    draft: false,
    prerelease: false,
    body: `Nightly build: [${llamaTag}]`,
    assets: [],
  };
  const build = { tag_name: llamaTag, draft: false, prerelease: true, assets: llamaAssets(llamaTag) };
  return async (path) => {
    if (path === "/repos/ollama/ollama/releases/latest") return ollama;
    if (path === "/repos/ggml-org/llama.cpp/releases/latest") return stable;
    if (path.includes("/releases?")) return [stable];
    if (path.endsWith(`/tags/${llamaTag}`)) return build;
    throw new Error(`unexpected GitHub fixture request ${path}`);
  };
}

function fixtureFetch({ foundationModelsPublished = false, images = "missing", imagesStatus = 500 } = {}) {
  return async (url, options = {}) => {
    if (url.includes("/images/")) {
      if (images === "missing") return new Response(null, { status: 404 });
      if (images === "error") return new Response(null, { status: imagesStatus });
      if (url.endsWith("runtime-manifest.json")) {
        const manifest = images === "malformed"
          ? { object: "msty.nexus.mlx_runtime", runtimeId: "images", runtimeVersion: "0.1.0" }
          : { object: "msty.nexus.images_runtime", runtimeId: "images", runtimeVersion: "0.1.0" };
        return new Response(options.method === "HEAD" ? null : JSON.stringify(manifest));
      }
      if (url.endsWith("checksums.txt")) {
        return new Response(images === "no-checksum" ? `${sha("f")}  other.tgz\n` : `${sha("f")}  msty-nexus-images.tgz\n`);
      }
      if (options.method === "HEAD" && url.endsWith("msty-nexus-images.tgz")) {
        return new Response(null, { headers: { "content-length": "41000000" } });
      }
    }
    if (url.includes("/foundationmodels/")) {
      if (!foundationModelsPublished) return new Response(null, { status: 404 });
      if (url.endsWith("runtime-manifest.json")) {
        return new Response(options.method === "HEAD" ? null : JSON.stringify({ object: "msty.nexus.foundationmodels_runtime", runtimeId: "foundationmodels", runtimeVersion: "0.1.0" }));
      }
      if (url.endsWith("checksums.txt")) return new Response(`${sha("e")}  msty-nexus-afm.tgz\n`);
      if (options.method === "HEAD" && url.endsWith("msty-nexus-afm.tgz")) {
        return new Response(null, { headers: { "content-length": "265000" } });
      }
    }
    if (url.endsWith("runtime-manifest.json")) {
      return new Response(JSON.stringify({ object: "msty.nexus.mlx_runtime", runtimeId: "mlx", runtimeVersion: "0.6.2" }));
    }
    if (url.endsWith("checksums.txt")) {
      return new Response(`${sha("c")}  msty-nexus-mlx.tgz\n`);
    }
    if (options.method === "HEAD" && url.includes("/mlx/0.6.2/")) {
      return new Response(null, { headers: { "content-length": "498540732" } });
    }
    throw new Error(`unexpected fetch fixture ${options.method ?? "GET"} ${url}`);
  };
}

test("builds a complete backend-aware feed without downloading direct archives", async () => {
  let bundleInput;
  const feed = await buildRuntimeFeed({
    github: fixtureGitHub(),
    fetchImpl: fixtureFetch(),
    now: () => new Date("2026-08-31T12:00:00Z"),
    resolveBundle: async (input) => {
      bundleInput = input;
      return {
        url: "https://github.com/cloudstack-llc/catalogs/releases/download/runtime-bundle-b1234/cuda.zip",
        sha256: sha("d"),
        sizeBytes: 123,
        archiveFormat: "zip",
      };
    },
  });
  validateRuntimeFeed(feed, "stable");
  assert.deepEqual(feed.releases.map((release) => release.runtimeVersion), ["v1.2.3", "b1234", "0.6.2"]);
  assert.equal(feed.releases[0].artifacts.length, 5);
  assert.equal(feed.releases[1].artifacts.length, REQUIRED_LLAMACPP_VARIANTS.length);
  assert.equal(bundleInput.primary.name, "llama-b1234-bin-win-cuda-12.4-x64.zip");
  assert.equal(bundleInput.components[0].name, "cudart-llama-bin-win-cuda-12.4-x64.zip");
});

test("follows only the stable llama.cpp release anchor", async () => {
  const github = fixtureGitHub();
  const release = await resolveStableLlamaRelease(github);
  assert.equal(release.tag_name, "b1234");
});

test("rejects GitHub assets without published digests", async () => {
  const github = fixtureGitHub();
  const wrapped = async (path) => {
    const value = structuredClone(await github(path));
    if (path.endsWith("/ollama/ollama/releases/latest")) delete value.assets[0].digest;
    return value;
  };
  await assert.rejects(
    buildRuntimeFeed({
      github: wrapped,
      fetchImpl: fixtureFetch(),
      resolveBundle: async () => assert.fail("bundle should not be reached"),
    }),
    /digest/,
  );
});

test("signs the exact feed payload and rejects tampering", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const seed = privateDer.subarray(-32).toString("base64");
  const publicRaw = publicDer.subarray(-32).toString("base64");
  const feed = await buildRuntimeFeed({
    github: fixtureGitHub(),
    fetchImpl: fixtureFetch(),
    resolveBundle: async () => ({
      url: "https://github.com/cloudstack-llc/catalogs/releases/download/runtime-bundle-b1234/cuda.zip",
      sha256: sha("d"),
      sizeBytes: 123,
      archiveFormat: "zip",
    }),
  });
  const signed = signRuntimeFeed(feed, seed, "test-key");
  assert.equal(verifySignedRuntimeFeed(signed, publicRaw, "stable").signature.keyId, "test-key");
  const tampered = signed.replace("v1.2.3", "v1.2.4");
  assert.throws(() => verifySignedRuntimeFeed(tampered, publicRaw, "stable"), /does not verify/);
  const reformatted = JSON.stringify(JSON.parse(signed), null, 2);
  assert.throws(() => verifySignedRuntimeFeed(reformatted, publicRaw, "stable"), /canonical serialization/);
});

const bundle = async () => ({
  url: "https://github.com/cloudstack-llc/catalogs/releases/download/runtime-bundle-b1234/cuda.zip",
  sha256: sha("d"),
  sizeBytes: 123,
  archiveFormat: "zip",
});

test("lists Apple Foundation Models only on enabled channels once published", async () => {
  const dev = await buildRuntimeFeed({
    github: fixtureGitHub(),
    fetchImpl: fixtureFetch({ foundationModelsPublished: true }),
    resolveBundle: bundle,
    channel: "dev",
  });
  const afm = dev.releases.find((release) => release.runtimeId === "foundationmodels");
  // The dev channel lists the dev publish, pinned by SHA-256.
  assert.equal(afm.artifacts[0].url, "https://nexus-assets.msty.ai/msty-nexus/runtime/foundationmodels/latest/dev/msty-nexus-afm.tgz");
  assert.equal(afm.artifacts[0].executablePath, "msty-nexus-afm_0.1.0_darwin_arm64/msty-nexus-afm");
  assert.equal(afm.artifacts[0].backend, "automatic");

  const unpublished = await buildRuntimeFeed({ github: fixtureGitHub(), fetchImpl: fixtureFetch(), resolveBundle: bundle, channel: "dev" });
  assert.equal(unpublished.releases.length, 3);

  const stable = await buildRuntimeFeed({
    github: fixtureGitHub(),
    fetchImpl: fixtureFetch({ foundationModelsPublished: true }),
    resolveBundle: bundle,
    channel: "stable",
  });
  assert.equal(stable.releases.some((release) => release.runtimeId === "foundationmodels"), false);
  const tampered = structuredClone(dev);
  for (const release of tampered.releases) release.channel = "stable";
  assert.throws(() => validateRuntimeFeed(tampered, "stable"), /not enabled for the stable channel/);
});

const build = (options) => buildRuntimeFeed({
  github: fixtureGitHub(),
  resolveBundle: bundle,
  ...options,
});
const runtimeIds = (feed) => feed.releases.map((release) => release.runtimeId);

test("v2 never lists the image runtime, even when it is published", async () => {
  for (const channel of ["stable", "dev"]) {
    const published = fixtureFetch({ foundationModelsPublished: true, images: "published" });
    const fetchImpl = async (url, options) => {
      assert.equal(url.includes("/images/"), false, "v2 must not ask for the image runtime");
      return published(url, options);
    };
    const v2 = await build({ fetchImpl, channel });
    assert.equal(runtimeIds(v2).includes("images"), false);

    // Without the image runtime, v3 has the same entries as v2.
    const v3 = await build({ fetchImpl: fixtureFetch({ foundationModelsPublished: true }), channel, feedVersion: 3 });
    assert.deepEqual(v3.releases.map(({ publishedAt: _, ...rest }) => rest), v2.releases.map(({ publishedAt: _, ...rest }) => rest));
  }
});

test("the v2 validator refuses a feed that lists the image runtime", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
  const publicRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const v3 = await build({ fetchImpl: fixtureFetch({ images: "published" }), feedVersion: 3 });

  assert.throws(() => validateRuntimeFeed(v3, "stable"), /unsupported runtime images in a v2 feed/);
  assert.throws(() => signRuntimeFeed(v3, seed, "test-key"), /unsupported runtime images in a v2 feed/);
  const signed = signRuntimeFeed(v3, seed, "test-key", { feedVersion: 3 });
  assert.throws(() => verifySignedRuntimeFeed(signed, publicRaw, "stable"), /unsupported runtime images in a v2 feed/);
  assert.equal(verifySignedRuntimeFeed(signed, publicRaw, "stable", { feedVersion: 3 }).feed.releases.length, 4);

  const unknown = structuredClone(v3);
  unknown.releases[3].runtimeId = "whisper";
  assert.throws(() => validateRuntimeFeed(unknown, "stable", { feedVersion: 3 }), /unsupported runtime whisper/);
  await assert.rejects(build({ fetchImpl: fixtureFetch(), feedVersion: 4 }), /runtime feed version/);
});

test("v3 lists the image runtime when its manifest exists", async () => {
  const stable = await build({ fetchImpl: fixtureFetch({ images: "published" }), feedVersion: 3 });
  assert.deepEqual(runtimeIds(stable), ["ollama", "llamacpp", "mlx", "images"]);
  // The stable channel points at the immutable versioned copy.
  const url = "https://nexus-assets.msty.ai/msty-nexus/runtime/images/0.1.0/msty-nexus-images.tgz";
  assert.deepEqual(stable.releases[3], {
    runtimeId: "images",
    channel: "stable",
    runtimeVersion: "0.1.0",
    publishedAt: stable.generatedAt,
    source: { type: "msty_asset", url },
    artifacts: [{
      os: "darwin",
      arch: "arm64",
      backend: "metal",
      url,
      sha256: sha("f"),
      sizeBytes: 41000000,
      archiveFormat: "tar.gz",
      executablePath: "msty-nexus-images_0.1.0_darwin_arm64/msty-nexus-images",
    }],
  });

  // The dev channel lists the dev publish, pinned by SHA-256.
  const dev = await build({ fetchImpl: fixtureFetch({ images: "published" }), channel: "dev", feedVersion: 3 });
  const images = dev.releases.find((release) => release.runtimeId === "images");
  assert.equal(images.artifacts[0].url, "https://nexus-assets.msty.ai/msty-nexus/runtime/images/latest/dev/msty-nexus-images.tgz");
  assert.equal(images.source.url, images.artifacts[0].url);
});

test("v3 leaves the image runtime out only when its manifest is missing", async () => {
  const missing = await build({ fetchImpl: fixtureFetch(), feedVersion: 3 });
  assert.deepEqual(runtimeIds(missing), ["ollama", "llamacpp", "mlx"]);

  // Published to the dev prefix only: dev lists it, stable does not.
  const published = fixtureFetch({ images: "published" });
  const devOnly = async (url, options) =>
    url.includes("/images/") && !url.includes("/images/latest/dev/")
      ? new Response(null, { status: 404 })
      : published(url, options);
  assert.equal(runtimeIds(await build({ fetchImpl: devOnly, channel: "dev", feedVersion: 3 })).includes("images"), true);
  assert.equal(runtimeIds(await build({ fetchImpl: devOnly, channel: "stable", feedVersion: 3 })).includes("images"), false);

  await assert.rejects(build({ fetchImpl: fixtureFetch({ images: "malformed" }), feedVersion: 3 }), /Image runtime manifest identity is invalid/);
  await assert.rejects(build({ fetchImpl: fixtureFetch({ images: "no-checksum" }), feedVersion: 3 }), /Image runtime checksum file/);
  await assert.rejects(build({ fetchImpl: fixtureFetch({ images: "error", imagesStatus: 403 }), feedVersion: 3 }), /HTTP 403/);
});
