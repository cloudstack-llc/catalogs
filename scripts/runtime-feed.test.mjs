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

function fixtureFetch() {
  return async (url, options = {}) => {
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
