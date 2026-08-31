// Discovers immutable Runtime artifacts and writes an unsigned schema-2 feed.
// Direct GitHub assets use GitHub's own SHA-256 metadata. Only split Windows
// CUDA assets are downloaded, merged, and published as one Nexus bundle.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildRuntimeFeed,
  createGitHubClient,
  serializeFeed,
} from "./runtime-feed-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleScript = resolve(repoRoot, "scripts/runtime_feed_bundle.py");
const githubToken = process.env.GITHUB_TOKEN?.trim() ?? "";

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

async function githubRelease(tag) {
  const response = await fetch(
    `https://api.github.com/repos/cloudstack-llc/catalogs/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "msty-catalogs-runtime-feed/1",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(githubToken === "" ? {} : { Authorization: `Bearer ${githubToken}` }),
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub bundle release lookup returned HTTP ${response.status}`);
  return response.json();
}

function bundleIdentity({ runtimeVersion, primary, components }) {
  const input = [primary, ...components].map((entry) => `${entry.name}:${entry.sha256}`).join("\n");
  const sourceDigest = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return {
    tag: `runtime-bundle-llamacpp-${runtimeVersion}`,
    name: `llamacpp-${runtimeVersion}-windows-amd64-cuda-${sourceDigest}.zip`,
  };
}

function releaseAsset(release, tag, name) {
  const asset = release?.assets?.find((entry) => entry?.name === name);
  if (asset === undefined) return undefined;
  const digest = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest ?? ""));
  if (digest === null || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`published bundle ${tag}/${name} has invalid digest metadata`);
  }
  const url = `https://github.com/cloudstack-llc/catalogs/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  if (asset.browser_download_url !== url) {
    throw new Error(`published bundle ${tag}/${name} has an unexpected URL`);
  }
  return {
    name,
    url,
    sha256: digest[1],
    sizeBytes: asset.size,
    archiveFormat: "zip",
  };
}

function materialReleases(feed) {
  return feed?.releases?.map(({ publishedAt: _publishedAt, ...release }) => release);
}

async function previousFeed(path) {
  if (path === undefined) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")).feed;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const channel = required(option(argv, "--channel", "stable"), "--channel");
  const out = resolve(repoRoot, required(option(argv, "--out"), "--out"));
  const bundlesOut = resolve(repoRoot, required(option(argv, "--bundles-out"), "--bundles-out"));
  const bundleDir = resolve(repoRoot, required(option(argv, "--bundle-dir"), "--bundle-dir"));
  const previousPathValue = option(argv, "--previous");
  const previousPath = previousPathValue === undefined ? undefined : resolve(repoRoot, previousPathValue);
  const github = createGitHubClient({ token: githubToken });
  const bundles = [];

  const resolveBundle = async (input) => {
    const identity = bundleIdentity(input);
    const published = releaseAsset(await githubRelease(identity.tag), identity.tag, identity.name);
    if (published !== undefined) return published;

    await mkdir(bundleDir, { recursive: true });
    const path = resolve(bundleDir, identity.name);
    try {
      await stat(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await run("python3", [
        bundleScript,
        "--output",
        path,
        "--required",
        "llama-server.exe",
        ...[input.primary, ...input.components].flatMap((entry) => [
          "--source",
          entry.url,
          entry.sha256,
        ]),
      ]);
    }
    const details = await stat(path);
    if (details.size <= 0 || details.size >= 2 * 1024 * 1024 * 1024) {
      throw new Error("assembled runtime bundle must be non-empty and smaller than GitHub's 2 GiB release-asset limit");
    }
    const sha256 = await fileDigest(path);
    bundles.push({
      tag: identity.tag,
      name: identity.name,
      path,
      sha256,
      sizeBytes: details.size,
      sources: [input.primary, ...input.components].map(({ name, sha256: digest }) => ({ name, sha256: digest })),
    });
    return {
      name: identity.name,
      url: `https://github.com/cloudstack-llc/catalogs/releases/download/${encodeURIComponent(identity.tag)}/${encodeURIComponent(identity.name)}`,
      sha256,
      sizeBytes: details.size,
      archiveFormat: "zip",
    };
  };

  const feed = await buildRuntimeFeed({ github, resolveBundle, channel });
  const previous = await previousFeed(previousPath);
  if (
    previous !== undefined &&
    JSON.stringify(materialReleases(previous)) === JSON.stringify(materialReleases(feed))
  ) {
    console.log(`unchanged: runtime feed ${channel}`);
    return;
  }

  await mkdir(dirname(out), { recursive: true });
  await mkdir(dirname(bundlesOut), { recursive: true });
  await writeFile(out, `${serializeFeed(feed)}\n`, "utf8");
  await writeFile(bundlesOut, `${JSON.stringify({ bundles }, null, 2)}\n`, "utf8");
  console.log(`wrote ${out}: ${feed.releases.map((release) => `${release.runtimeId}@${release.runtimeVersion}`).join(", ")}`);
}

await main();
