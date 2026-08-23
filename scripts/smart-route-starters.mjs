const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENDPOINT_FAMILIES = new Set([
  "anthropic.messages",
  "openai.chat_completions",
  "openai.images",
  "openai.responses",
]);
const BANNED_WORDS = new Set([
  "delve",
  "empower",
  "facilitate",
  "foster",
  "harness",
  "leverage",
  "robust",
  "streamline",
  "supercharge",
  "transformative",
  "utilize",
]);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function cleanText(problems, value, label, maxBytes, direct = false) {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    problems.push(`${label} must be a non-empty trimmed string`);
    return "";
  }
  if (byteLength(value) > maxBytes) {
    problems.push(`${label} is longer than ${maxBytes} bytes`);
  }
  if (/\p{Cc}/u.test(value) || /[<>]/.test(value)) {
    problems.push(`${label} contains control characters or markup`);
  }
  if (value.includes("—")) {
    problems.push(`${label} uses an em dash`);
  }
  if (direct && /^I(?:\b|['’])/.test(value)) {
    problems.push(`${label} must describe the item directly`);
  }
  const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const word of words) {
    if (BANNED_WORDS.has(word)) {
      problems.push(`${label} uses banned word ${word}`);
    }
  }
  return value;
}

function exactKeys(problems, value, label, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      problems.push(`${label} has unsupported field ${key}`);
    }
  }
  return true;
}

function validID(problems, value, label) {
  if (typeof value !== "string" || !ID.test(value) || value.length > 64) {
    problems.push(`${label} must be a lowercase kebab-case id up to 64 characters`);
    return "";
  }
  return value;
}

function findForbiddenTargetFields(value, path, problems) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      findForbiddenTargetFields(entry, `${path}[${index}]`, problems),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/model.?id/i.test(key) || /target.?id/i.test(key)) {
      problems.push(`${path}.${key} must not bind a starter to a model`);
    }
    findForbiddenTargetFields(entry, `${path}.${key}`, problems);
  }
}

export function validateSmartRouteStarters(artifact) {
  const problems = [];
  if (!exactKeys(
    problems,
    artifact,
    "artifact",
    new Set(["schema_version", "generated_at", "locale", "collections", "starters"]),
  )) return problems;

  if (artifact.schema_version !== 1) {
    problems.push("schema_version must be 1");
  }
  const directCopy = true;
  if (
    typeof artifact.generated_at !== "string" ||
    Number.isNaN(Date.parse(artifact.generated_at))
  ) {
    problems.push("generated_at must be an RFC 3339 timestamp");
  }
  if (artifact.locale !== "en") {
    problems.push("locale must be en for the published artifact");
  }
  if (!Array.isArray(artifact.starters) || artifact.starters.length === 0) {
    problems.push("starters must contain at least one starter");
  }
  if ((artifact.starters?.length ?? 0) > 100) {
    problems.push("starters must contain at most 100 starters");
  }

  const starterIDs = new Set();
  for (const [starterIndex, starter] of (artifact.starters ?? []).entries()) {
    const label = `starters[${starterIndex}]`;
    if (!exactKeys(
      problems,
      starter,
      label,
      new Set([
        "id",
        "revision",
        "name",
        "summary",
        "notice",
        "tags",
        "endpoint_families",
        "lanes",
        "fallback",
      ]),
    )) continue;

    const id = validID(problems, starter.id, `${label}.id`);
    if (starterIDs.has(id)) problems.push(`${label}.id duplicates ${id}`);
    if (id !== "") starterIDs.add(id);
    if (!Number.isInteger(starter.revision) || starter.revision < 1) {
      problems.push(`${label}.revision must be a positive integer`);
    }
    cleanText(problems, starter.name, `${label}.name`, 128);
    cleanText(problems, starter.summary, `${label}.summary`, 256, directCopy);
    if (starter.notice !== undefined) {
      cleanText(problems, starter.notice, `${label}.notice`, 256, directCopy);
    }

    if (!Array.isArray(starter.tags) || starter.tags.length === 0 || starter.tags.length > 12) {
      problems.push(`${label}.tags must contain 1 to 12 tags`);
    } else {
      const tags = new Set();
      for (const [tagIndex, tag] of starter.tags.entries()) {
        const parsed = validID(problems, tag, `${label}.tags[${tagIndex}]`);
        if (tags.has(parsed)) problems.push(`${label}.tags duplicates ${parsed}`);
        tags.add(parsed);
      }
    }

    if (
      !Array.isArray(starter.endpoint_families) ||
      starter.endpoint_families.length === 0 ||
      starter.endpoint_families.length > ENDPOINT_FAMILIES.size
    ) {
      problems.push(`${label}.endpoint_families must contain supported generation endpoints`);
    } else {
      const families = new Set();
      for (const family of starter.endpoint_families) {
        if (!ENDPOINT_FAMILIES.has(family)) {
          problems.push(`${label}.endpoint_families contains unsupported endpoint ${family}`);
        }
        if (families.has(family)) {
          problems.push(`${label}.endpoint_families duplicates ${family}`);
        }
        families.add(family);
      }
    }

    if (!Array.isArray(starter.lanes) || starter.lanes.length < 2 || starter.lanes.length > 12) {
      problems.push(`${label}.lanes must contain 2 to 12 lanes`);
    } else {
      const laneIDs = new Set();
      for (const [laneIndex, lane] of starter.lanes.entries()) {
        const laneLabel = `${label}.lanes[${laneIndex}]`;
        if (!exactKeys(
          problems,
          lane,
          laneLabel,
          new Set(["id", "name", "description", "target_hint"]),
        )) continue;
        const laneID = validID(problems, lane.id, `${laneLabel}.id`);
        if (laneIDs.has(laneID)) problems.push(`${laneLabel}.id duplicates ${laneID}`);
        laneIDs.add(laneID);
        cleanText(problems, lane.name, `${laneLabel}.name`, 128);
        cleanText(problems, lane.description, `${laneLabel}.description`, 512, directCopy);
        cleanText(problems, lane.target_hint, `${laneLabel}.target_hint`, 256, directCopy);
      }
    }

    if (exactKeys(problems, starter.fallback, `${label}.fallback`, new Set(["target_hint"]))) {
      cleanText(
        problems,
        starter.fallback.target_hint,
        `${label}.fallback.target_hint`,
        256,
        directCopy,
      );
    }
  }

  if (!Array.isArray(artifact.collections) || artifact.collections.length === 0) {
    problems.push("collections must contain at least one collection");
  }
  if ((artifact.collections?.length ?? 0) > 20) {
    problems.push("collections must contain at most 20 collections");
  }
  const collectionIDs = new Set();
  const referenced = new Set();
  for (const [collectionIndex, collection] of (artifact.collections ?? []).entries()) {
    const label = `collections[${collectionIndex}]`;
    if (!exactKeys(
      problems,
      collection,
      label,
      new Set(["id", "title", "description", "starters"]),
    )) continue;
    const id = validID(problems, collection.id, `${label}.id`);
    if (collectionIDs.has(id)) problems.push(`${label}.id duplicates ${id}`);
    collectionIDs.add(id);
    cleanText(problems, collection.title, `${label}.title`, 128);
    cleanText(problems, collection.description, `${label}.description`, 256, directCopy);
    if (!Array.isArray(collection.starters) || collection.starters.length === 0) {
      problems.push(`${label}.starters must contain at least one starter id`);
      continue;
    }
    const localReferences = new Set();
    for (const [referenceIndex, reference] of collection.starters.entries()) {
      validID(problems, reference, `${label}.starters[${referenceIndex}]`);
      if (!starterIDs.has(reference)) {
        problems.push(`${label}.starters references missing starter ${reference}`);
      }
      if (localReferences.has(reference)) {
        problems.push(`${label}.starters duplicates ${reference}`);
      }
      localReferences.add(reference);
      referenced.add(reference);
    }
  }
  for (const id of starterIDs) {
    if (!referenced.has(id)) problems.push(`starter ${id} is not in a collection`);
  }

  findForbiddenTargetFields(artifact, "artifact", problems);
  return problems;
}
