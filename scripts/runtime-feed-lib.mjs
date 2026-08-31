import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export const FEED_SCHEMA_VERSION = 2;
export const SIGNED_FEED_SCHEMA_VERSION = 1;
export const SIGNATURE_ALGORITHM = "ed25519";
export const DEFAULT_KEY_ID = "msty-runtime-feed-1";
export const DEFAULT_PUBLIC_KEY =
  "5rZcCrp9d0WhHcuQk+rk9GDJtKizYK0LufQ551FltdA=";
export const DEFAULT_MLX_ASSET_URL =
  "https://nexus-assets.msty.ai/msty-nexus/runtime/mlx/latest/msty-nexus-mlx.tgz";

const GITHUB_API = "https://api.github.com";
const GITHUB_DIGEST = /^sha256:([0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LLAMA_BUILD = /^b[0-9]+$/;
const LLAMA_STABLE = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const LLAMA_STABLE_BUILD = /^\s*(?:\*\*)?Nightly build:(?:\*\*)?\s*\[?(b[0-9]+)/im;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PLATFORM_PART = /^[a-z0-9][a-z0-9_]*$/;
const RUNTIME_BACKENDS = new Set(["automatic", "cpu", "metal", "cuda", "rocm", "vulkan", "sycl"]);
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const REQUIRED_LLAMACPP_VARIANTS = [
  ["darwin", "arm64", "automatic"],
  ["darwin", "arm64", "metal"],
  ["linux", "amd64", "cpu"],
  ["linux", "amd64", "rocm"],
  ["linux", "amd64", "vulkan"],
  ["linux", "amd64", "sycl"],
  ["linux", "arm64", "cpu"],
  ["linux", "arm64", "vulkan"],
  ["windows", "amd64", "cpu"],
  ["windows", "amd64", "cuda"],
  ["windows", "amd64", "rocm"],
  ["windows", "amd64", "vulkan"],
  ["windows", "amd64", "sycl"],
  ["windows", "arm64", "cpu"],
];

const OLLAMA_TARGETS = [
  ["darwin", "arm64", "automatic", "ollama-darwin.tgz", "ollama"],
  ["linux", "amd64", "automatic", "ollama-linux-amd64.tar.zst", "bin/ollama"],
  ["linux", "arm64", "automatic", "ollama-linux-arm64.tar.zst", "bin/ollama"],
  ["windows", "amd64", "automatic", "ollama-windows-amd64.zip", "ollama.exe"],
  ["windows", "arm64", "automatic", "ollama-windows-arm64.zip", "ollama.exe"],
];

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function object(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function string(value, label) {
  invariant(typeof value === "string" && value.trim() !== "", `${label} must be a non-empty string`);
  return value.trim();
}

function integer(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function archiveFormat(name) {
  if (name.endsWith(".tar.zst")) return "tar.zst";
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return "tar.gz";
  if (name.endsWith(".zip")) return "zip";
  throw new Error(`unsupported runtime archive ${name}`);
}

function assetURL(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function checkedGitHubAsset(release, repo, matcher, label) {
  const assets = Array.isArray(release.assets) ? [...release.assets] : [];
  assets.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  let asset;
  for (const preferred of matcher.names ?? []) {
    asset = assets.find((entry) => entry?.name === preferred);
    if (asset !== undefined) break;
  }
  asset ??= assets.find((entry) => matcher(String(entry?.name ?? "")));
  invariant(asset !== undefined, `${label} asset was not found`);
  const name = string(asset.name, `${label}.name`);
  const tag = string(release.tag_name, `${label}.tag`);
  const expectedURL = assetURL(repo, tag, name);
  invariant(asset.browser_download_url === expectedURL, `${label}.url did not match its GitHub release identity`);
  const match = GITHUB_DIGEST.exec(String(asset.digest ?? ""));
  invariant(match !== null, `${label}.digest must contain a GitHub SHA-256 digest`);
  return {
    name,
    url: expectedURL,
    sha256: match[1],
    sizeBytes: integer(asset.size, `${label}.size`),
    archiveFormat: archiveFormat(name),
  };
}

function exact(name) {
  const matcher = (candidate) => candidate === name;
  matcher.names = [name];
  return matcher;
}

function oneOf(names) {
  const matcher = (candidate) => names.includes(candidate);
  matcher.names = [...names];
  return matcher;
}

function regex(pattern) {
  return (candidate) => pattern.test(candidate);
}

function artifact(target, selected, executablePath) {
  const [os, arch, backend] = target;
  return {
    os,
    arch,
    backend,
    url: selected.url,
    sha256: selected.sha256,
    sizeBytes: selected.sizeBytes,
    archiveFormat: selected.archiveFormat,
    executablePath,
  };
}

function llamaExecutable(tag, os) {
  return os === "windows" ? "llama-server.exe" : `llama-${tag}/llama-server`;
}

function llamaSelection(build, os, arch, backend) {
  const number = build.slice(1);
  if (os === "darwin" && arch === "arm64") {
    return {
      matcher: oneOf([
        `llama-b${number}-bin-macos-arm64-kleidiai.tar.gz`,
        `llama-b${number}-bin-macos-arm64.tar.gz`,
        `llama-b${number}-bin-macos-arm64.zip`,
      ]),
    };
  }
  if (os === "linux" && arch === "amd64") {
    if (backend === "cpu") return { matcher: exact(`llama-b${number}-bin-ubuntu-x64.tar.gz`) };
    if (backend === "vulkan") return { matcher: exact(`llama-b${number}-bin-ubuntu-vulkan-x64.tar.gz`) };
    if (backend === "sycl") {
      return { matcher: oneOf([
        `llama-b${number}-bin-ubuntu-sycl-fp32-x64.tar.gz`,
        `llama-b${number}-bin-ubuntu-sycl-fp16-x64.tar.gz`,
      ]) };
    }
    if (backend === "rocm") {
      return { matcher: regex(new RegExp(`^llama-b${number}-bin-ubuntu-rocm-[0-9]+(?:\\.[0-9]+)*-x64\\.tar\\.gz$`)) };
    }
  }
  if (os === "linux" && arch === "arm64") {
    if (backend === "cpu") return { matcher: exact(`llama-b${number}-bin-ubuntu-arm64.tar.gz`) };
    if (backend === "vulkan") return { matcher: exact(`llama-b${number}-bin-ubuntu-vulkan-arm64.tar.gz`) };
  }
  if (os === "windows" && arch === "arm64" && backend === "cpu") {
    return { matcher: exact(`llama-b${number}-bin-win-cpu-arm64.zip`) };
  }
  if (os === "windows" && arch === "amd64") {
    if (backend === "cpu") return { matcher: exact(`llama-b${number}-bin-win-cpu-x64.zip`) };
    if (backend === "vulkan") return { matcher: exact(`llama-b${number}-bin-win-vulkan-x64.zip`) };
    if (backend === "sycl") return { matcher: exact(`llama-b${number}-bin-win-sycl-x64.zip`) };
    if (backend === "rocm") {
      return { matcher: (name) =>
        new RegExp(`^llama-b${number}-bin-win-rocm-[0-9]+(?:\\.[0-9]+)*-x64\\.zip$`).test(name) ||
        name === `llama-b${number}-bin-win-hip-radeon-x64.zip` };
    }
    if (backend === "cuda") {
      const pairs = [
        [
          `llama-b${number}-bin-win-cuda-12.4-x64.zip`,
          "cudart-llama-bin-win-cuda-12.4-x64.zip",
        ],
        [
          `llama-b${number}-bin-win-cuda-13.3-x64.zip`,
          "cudart-llama-bin-win-cuda-13.3-x64.zip",
        ],
      ];
      return { pairs };
    }
  }
  throw new Error(`unsupported llama.cpp target ${os}/${arch}/${backend}`);
}

function selectCudaPair(release, repo, pairs) {
  for (const [primaryName, componentName] of pairs) {
    const names = new Set((release.assets ?? []).map((asset) => asset?.name));
    if (!names.has(primaryName) || !names.has(componentName)) continue;
    return {
      primary: checkedGitHubAsset(release, repo, exact(primaryName), "llamacpp.cuda.primary"),
      components: [checkedGitHubAsset(release, repo, exact(componentName), "llamacpp.cuda.component")],
    };
  }
  throw new Error("llamacpp.cuda components were not found");
}

export function createGitHubClient({ token = "", fetchImpl = fetch } = {}) {
  return async function github(path) {
    invariant(path.startsWith("/"), "GitHub API path must start with /");
    const response = await fetchWithRetry(`${GITHUB_API}${path}`, {
      fetchImpl,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "msty-catalogs-runtime-feed/1",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token.trim() === "" ? {} : { Authorization: `Bearer ${token.trim()}` }),
      },
    });
    return response.json();
  };
}

export async function fetchWithRetry(
  url,
  { fetchImpl = fetch, headers = {}, method = "GET", attempts = 4, timeoutMs = 60_000 } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      if (![429, 502, 503, 504].includes(response.status) || attempt === attempts) {
        throw new Error(`${method} ${new URL(url).host} returned HTTP ${response.status}`);
      }
      lastError = new Error(`${method} ${new URL(url).host} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

export async function resolveStableLlamaRelease(github) {
  const latest = object(
    await github("/repos/ggml-org/llama.cpp/releases/latest"),
    "latest stable llama.cpp release",
  );
  const latestTag = String(latest.tag_name ?? "").trim();
  if (latest.draft !== true && latest.prerelease !== true && LLAMA_BUILD.test(latestTag)) {
    return latest;
  }
  if (latest.draft !== true && latest.prerelease !== true && LLAMA_STABLE.test(latestTag)) {
    const match = LLAMA_STABLE_BUILD.exec(String(latest.body ?? ""));
    invariant(match !== null, "latest stable llama.cpp release is missing its nightly build anchor");
    const build = await github(`/repos/ggml-org/llama.cpp/releases/tags/${encodeURIComponent(match[1])}`);
    invariant(build?.draft !== true && build?.tag_name === match[1], "llama.cpp stable anchor referenced an invalid build");
    return build;
  }

  // Keep a bounded compatibility fallback for older repositories where the
  // latest endpoint did not identify a stable build release directly.
  for (let page = 1; page <= 4; page += 1) {
    const releases = await github(`/repos/ggml-org/llama.cpp/releases?per_page=30&page=${page}`);
    invariant(Array.isArray(releases) && releases.length > 0, "llama.cpp release list was empty");
    for (const candidate of releases) {
      const release = object(candidate, "llama.cpp release");
      const tag = String(release.tag_name ?? "").trim();
      if (release.draft === true) continue;
      if (release.prerelease !== true && LLAMA_BUILD.test(tag)) return release;
      if (release.prerelease === true || !LLAMA_STABLE.test(tag)) continue;
      const match = LLAMA_STABLE_BUILD.exec(String(release.body ?? ""));
      if (match === null) continue;
      const build = await github(`/repos/ggml-org/llama.cpp/releases/tags/${encodeURIComponent(match[1])}`);
      invariant(build?.draft !== true && build?.tag_name === match[1], "llama.cpp stable anchor referenced an invalid build");
      return build;
    }
    if (releases.length < 30) break;
  }
  throw new Error("compatible stable llama.cpp release was not found");
}

async function buildOllamaRelease(github, channel, publishedAt) {
  const release = object(await github("/repos/ollama/ollama/releases/latest"), "Ollama release");
  const tag = string(release.tag_name, "Ollama release tag");
  invariant(release.draft !== true && release.prerelease !== true, "Ollama latest release must be stable");
  const artifacts = OLLAMA_TARGETS.map(([os, arch, backend, name, executablePath]) => {
    const selected = checkedGitHubAsset(release, "ollama/ollama", exact(name), `ollama.${os}.${arch}`);
    return artifact([os, arch, backend], selected, executablePath);
  });
  return {
    runtimeId: "ollama",
    channel,
    runtimeVersion: tag,
    publishedAt,
    source: { type: "github_release", repo: "ollama/ollama", tag },
    artifacts,
  };
}

async function buildLlamaRelease(github, resolveBundle, channel, publishedAt) {
  const release = await resolveStableLlamaRelease(github);
  const tag = string(release.tag_name, "llama.cpp build tag");
  invariant(LLAMA_BUILD.test(tag), "llama.cpp build tag must use bNNNN format");
  const artifacts = [];
  for (const target of REQUIRED_LLAMACPP_VARIANTS) {
    const [os, arch, backend] = target;
    const selection = llamaSelection(tag, os, arch, backend);
    if (selection.pairs !== undefined) {
      const pair = selectCudaPair(release, "ggml-org/llama.cpp", selection.pairs);
      const bundled = await resolveBundle({
        runtimeVersion: tag,
        os,
        arch,
        backend,
        primary: pair.primary,
        components: pair.components,
      });
      artifacts.push(artifact(target, bundled, llamaExecutable(tag, os)));
      continue;
    }
    const selected = checkedGitHubAsset(
      release,
      "ggml-org/llama.cpp",
      selection.matcher,
      `llamacpp.${os}.${arch}.${backend}`,
    );
    artifacts.push(artifact(target, selected, llamaExecutable(tag, os)));
  }
  return {
    runtimeId: "llamacpp",
    channel,
    runtimeVersion: tag,
    publishedAt,
    source: { type: "github_release", repo: "ggml-org/llama.cpp", tag },
    artifacts,
  };
}

function mlxMetadataPrefix(assetURL) {
  const parsed = new URL(assetURL);
  invariant(parsed.protocol === "https:" && parsed.search === "" && parsed.hash === "", "MLX asset URL must be immutable HTTPS metadata input");
  invariant(parsed.pathname.endsWith("/msty-nexus-mlx.tgz"), "MLX asset URL must end with msty-nexus-mlx.tgz");
  return assetURL.slice(0, -"msty-nexus-mlx.tgz".length);
}

async function buildMLXRelease(fetchImpl, channel, publishedAt, mlxAssetURL) {
  const prefix = mlxMetadataPrefix(mlxAssetURL);
  const manifestResponse = await fetchWithRetry(`${prefix}runtime-manifest.json`, { fetchImpl });
  const manifest = object(await manifestResponse.json(), "MLX runtime manifest");
  invariant(manifest.object === "msty.nexus.mlx_runtime" && manifest.runtimeId === "mlx", "MLX runtime manifest identity is invalid");
  const version = string(manifest.runtimeVersion, "MLX runtime version");
  invariant(SEMVER.test(version), "MLX runtime version must be semantic");
  const checksumResponse = await fetchWithRetry(`${prefix}checksums.txt`, { fetchImpl });
  const checksumText = await checksumResponse.text();
  const checksumLine = checksumText.split(/\r?\n/).find((line) => line.trim().endsWith("msty-nexus-mlx.tgz"));
  const sha256 = String(checksumLine ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  invariant(SHA256.test(sha256), "MLX checksum file did not contain a valid archive SHA-256");
  const versionedURL = mlxAssetURL.replace("/mlx/latest/", `/mlx/${version}/`);
  invariant(versionedURL !== mlxAssetURL, "MLX latest URL could not be made immutable");
  const head = await fetchWithRetry(versionedURL, { fetchImpl, method: "HEAD" });
  const sizeBytes = Number(head.headers.get("content-length"));
  integer(sizeBytes, "MLX artifact content-length");
  return {
    runtimeId: "mlx",
    channel,
    runtimeVersion: version,
    publishedAt,
    source: { type: "msty_asset", url: versionedURL },
    artifacts: [{
      os: "darwin",
      arch: "arm64",
      backend: "metal",
      url: versionedURL,
      sha256,
      sizeBytes,
      archiveFormat: "tar.gz",
      executablePath: `msty-nexus-mlx_${version}_darwin_arm64/msty-nexus-mlx`,
    }],
  };
}

export async function buildRuntimeFeed({
  github,
  resolveBundle,
  channel = "stable",
  now = () => new Date(),
  fetchImpl = fetch,
  mlxAssetURL = DEFAULT_MLX_ASSET_URL,
}) {
  invariant(channel === "stable" || channel === "dev", "runtime feed channel must be stable or dev");
  invariant(typeof github === "function", "GitHub client is required");
  invariant(typeof resolveBundle === "function", "runtime bundle resolver is required");
  const publishedAt = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const releases = [];
  releases.push(await buildOllamaRelease(github, channel, publishedAt));
  releases.push(await buildLlamaRelease(github, resolveBundle, channel, publishedAt));
  releases.push(await buildMLXRelease(fetchImpl, channel, publishedAt, mlxAssetURL));
  const feed = { schemaVersion: FEED_SCHEMA_VERSION, generatedAt: publishedAt, releases };
  validateRuntimeFeed(feed, channel);
  return feed;
}

export function validateRuntimeFeed(feed, expectedChannel) {
  object(feed, "feed");
  invariant(feed.schemaVersion === FEED_SCHEMA_VERSION, `feed.schemaVersion must be ${FEED_SCHEMA_VERSION}`);
  invariant(Array.isArray(feed.releases) && feed.releases.length === 3, "feed must contain exactly three runtime releases");
  const byID = new Map();
  for (const [releaseIndex, releaseValue] of feed.releases.entries()) {
    const release = object(releaseValue, `feed.releases[${releaseIndex}]`);
    const runtimeId = string(release.runtimeId, `feed.releases[${releaseIndex}].runtimeId`);
    invariant(["ollama", "llamacpp", "mlx"].includes(runtimeId), `unsupported runtime ${runtimeId}`);
    invariant(!byID.has(runtimeId), `duplicate runtime ${runtimeId}`);
    byID.set(runtimeId, release);
    invariant(release.channel === expectedChannel, `${runtimeId}.channel must be ${expectedChannel}`);
    const runtimeVersion = string(release.runtimeVersion, `${runtimeId}.runtimeVersion`);
    invariant(
      runtimeVersion !== "." && runtimeVersion !== ".." && !runtimeVersion.includes("/") && !runtimeVersion.includes("\\"),
      `${runtimeId}.runtimeVersion must be a single path segment`,
    );
    invariant(Array.isArray(release.artifacts) && release.artifacts.length > 0, `${runtimeId}.artifacts must not be empty`);
    const seen = new Set();
    for (const [index, value] of release.artifacts.entries()) {
      const entry = object(value, `${runtimeId}.artifacts[${index}]`);
      const os = string(entry.os, `${runtimeId}.artifacts[${index}].os`);
      const arch = string(entry.arch, `${runtimeId}.artifacts[${index}].arch`);
      const backend = string(entry.backend, `${runtimeId}.artifacts[${index}].backend`);
      invariant(PLATFORM_PART.test(os) && PLATFORM_PART.test(arch), `${runtimeId} artifact platform must use lowercase Go naming`);
      invariant(RUNTIME_BACKENDS.has(backend), `${runtimeId} artifact backend is invalid`);
      const key = `${os}/${arch}/${backend}`;
      invariant(!seen.has(key), `${runtimeId} contains duplicate artifact ${key}`);
      seen.add(key);
      const url = new URL(string(entry.url, `${runtimeId}.artifacts[${index}].url`));
      invariant(
        url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "",
        `${runtimeId} artifact URL must be immutable credential-free HTTPS`,
      );
      invariant(SHA256.test(String(entry.sha256 ?? "")), `${runtimeId} artifact SHA-256 is invalid`);
      integer(entry.sizeBytes, `${runtimeId}.artifacts[${index}].sizeBytes`);
      invariant(["tar.gz", "tar.zst", "zip"].includes(entry.archiveFormat), `${runtimeId} archive format is invalid`);
      const executablePath = string(entry.executablePath, `${runtimeId}.artifacts[${index}].executablePath`);
      invariant(
        !executablePath.startsWith("/") && !executablePath.includes("\\") &&
          !executablePath.split("/").includes(".."),
        `${runtimeId} executable path must be a safe relative archive path`,
      );
    }
  }
  invariant(byID.has("ollama") && byID.has("llamacpp") && byID.has("mlx"), "feed is missing a required runtime");
  const llama = byID.get("llamacpp");
  const llamaKeys = new Set(llama.artifacts.map((entry) => `${entry.os}/${entry.arch}/${entry.backend}`));
  for (const target of REQUIRED_LLAMACPP_VARIANTS) {
    invariant(llamaKeys.has(target.join("/")), `feed is missing llama.cpp ${target.join("/")}`);
  }
  return feed;
}

export function serializeFeed(feed) {
  return JSON.stringify(feed);
}

function privateKeyFromRaw(value) {
  const raw = Buffer.from(value, "base64");
  invariant(raw.length === 32 || raw.length === 64, "runtime feed private key must decode to a 32-byte seed or 64-byte private key");
  const seed = raw.subarray(0, 32);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  if (raw.length === 64) {
    const derived = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
    invariant(derived.equals(raw.subarray(32)), "runtime feed private key public suffix does not match its seed");
  }
  return key;
}

function publicKeyFromRaw(value) {
  const raw = Buffer.from(value, "base64");
  invariant(raw.length === 32, "runtime feed public key must decode to 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export function signRuntimeFeed(feed, privateKeyBase64, keyId = DEFAULT_KEY_ID) {
  invariant(KEY_ID.test(keyId), "runtime feed signing key ID is invalid");
  validateRuntimeFeed(feed, feed.releases?.[0]?.channel);
  const feedJSON = serializeFeed(feed);
  const signature = {
    algorithm: SIGNATURE_ALGORITHM,
    keyId,
    value: sign(null, Buffer.from(feedJSON), privateKeyFromRaw(privateKeyBase64)).toString("base64"),
  };
  return `{"schemaVersion":${SIGNED_FEED_SCHEMA_VERSION},"feed":${feedJSON},"signature":${JSON.stringify(signature)}}\n`;
}

export function verifySignedRuntimeFeed(text, publicKeyBase64 = DEFAULT_PUBLIC_KEY, expectedChannel) {
  const envelope = object(JSON.parse(text), "signed feed");
  invariant(envelope.schemaVersion === SIGNED_FEED_SCHEMA_VERSION, `signed feed schemaVersion must be ${SIGNED_FEED_SCHEMA_VERSION}`);
  invariant(envelope.signature?.algorithm === SIGNATURE_ALGORITHM, "signed feed algorithm must be ed25519");
  invariant(KEY_ID.test(String(envelope.signature?.keyId ?? "")), "signed feed key ID is invalid");
  validateRuntimeFeed(envelope.feed, expectedChannel ?? envelope.feed?.releases?.[0]?.channel);
  const signature = Buffer.from(String(envelope.signature?.value ?? ""), "base64");
  invariant(signature.length === 64, "signed feed signature must decode to 64 bytes");
  const canonical = `{"schemaVersion":${SIGNED_FEED_SCHEMA_VERSION},"feed":${serializeFeed(envelope.feed)},"signature":${JSON.stringify(envelope.signature)}}`;
  invariant(text.trim() === canonical, "signed feed must use canonical serialization");
  invariant(
    verify(null, Buffer.from(serializeFeed(envelope.feed)), publicKeyFromRaw(publicKeyBase64), signature),
    "signed feed signature does not verify",
  );
  return envelope;
}

export function sha256FileBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
