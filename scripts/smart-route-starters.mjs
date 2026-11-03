const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENDPOINT_FAMILIES = new Set([
  "anthropic.messages",
  "openai.chat_completions",
  "openai.images",
  "openai.responses",
]);
// Rule facts and operators a starter rule may use. They match the Msty Nexus
// Runtime that reads rule_starters; a Runtime drops a starter whose rule it
// cannot read, so a new fact needs that Runtime first.
const RULE_FACTS = new Set([
  "request.promptTokens",
  "request.reasoningEffort",
  "request.hasImages",
  "request.hasTools",
  "protection.categories",
  "caller.dailyTokens",
  "caller.monthlyTokens",
  "caller.tokenLabels",
  "conversation.turns",
  "conversation.tokensSoFar",
  "time.hour",
  "time.weekday",
  "time.businessHours",
  "route.spend.monthPercent",
  "random.percent",
]);
const RULE_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "has"]);
const RULE_TARGETS = new Set(["fallback", "router"]);
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

// validateRules checks a rule starter's rules. A rule names no model: it
// sends to "fallback" or "router", or gives a target_hint the person picks a
// model for, as they do for each lane.
function validateRules(problems, rules, label) {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 8) {
    problems.push(`${label} must contain 1 to 8 rules`);
    return;
  }
  const ruleIDs = new Set();
  for (const [ruleIndex, rule] of rules.entries()) {
    const ruleLabel = `${label}[${ruleIndex}]`;
    if (!exactKeys(problems, rule, ruleLabel, new Set(["id", "name", "when", "then"]))) continue;
    const ruleID = validID(problems, rule.id, `${ruleLabel}.id`);
    if (ruleIDs.has(ruleID)) problems.push(`${ruleLabel}.id duplicates ${ruleID}`);
    ruleIDs.add(ruleID);
    cleanText(problems, rule.name, `${ruleLabel}.name`, 120);
    if (!Array.isArray(rule.when) || rule.when.length === 0 || rule.when.length > 8) {
      problems.push(`${ruleLabel}.when must contain 1 to 8 conditions`);
    } else {
      for (const [conditionIndex, condition] of rule.when.entries()) {
        const conditionLabel = `${ruleLabel}.when[${conditionIndex}]`;
        if (!exactKeys(problems, condition, conditionLabel, new Set(["fact", "op", "value"]))) continue;
        if (!RULE_FACTS.has(condition.fact)) {
          problems.push(`${conditionLabel}.fact is not a rule fact`);
        }
        if (!RULE_OPS.has(condition.op)) {
          problems.push(`${conditionLabel}.op is not a rule operator`);
        }
        const value = condition.value;
        const valid =
          (typeof value === "number" && Number.isFinite(value)) ||
          typeof value === "boolean" ||
          (typeof value === "string" && value !== "") ||
          (Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === "string" && word !== ""));
        if (!valid) problems.push(`${conditionLabel}.value must be a number, true or false, a word, or a list of words`);
      }
    }
    if (!exactKeys(problems, rule.then, `${ruleLabel}.then`, new Set(["target", "target_hint"]))) continue;
    const hasTarget = rule.then.target !== undefined;
    const hasHint = rule.then.target_hint !== undefined;
    if (hasTarget === hasHint) {
      problems.push(`${ruleLabel}.then must name exactly one of target and target_hint`);
    } else if (hasTarget && !RULE_TARGETS.has(rule.then.target)) {
      problems.push(`${ruleLabel}.then.target must be fallback or router`);
    } else if (hasHint) {
      cleanText(problems, rule.then.target_hint, `${ruleLabel}.then.target_hint`, 256, true);
    }
  }
}

export function validateSmartRouteStarters(artifact) {
  const problems = [];
  if (!exactKeys(
    problems,
    artifact,
    "artifact",
    new Set(["schema_version", "generated_at", "locale", "collections", "starters", "rule_starters"]),
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
  if (artifact.rule_starters !== undefined && !Array.isArray(artifact.rule_starters)) {
    problems.push("rule_starters must be a list");
  }
  if ((artifact.starters?.length ?? 0) + (artifact.rule_starters?.length ?? 0) > 100) {
    problems.push("starters and rule_starters must contain at most 100 starters together");
  }

  // Rule starters live apart from starters: a Runtime that predates starter
  // rules reads starters only, so it never offers one without its rules.
  const starterIDs = new Set();
  const entries = [
    ...(artifact.starters ?? []).map((starter, index) => [starter, `starters[${index}]`, false]),
    ...(Array.isArray(artifact.rule_starters) ? artifact.rule_starters : []).map((starter, index) => [starter, `rule_starters[${index}]`, true]),
  ];
  for (const [starter, label, withRules] of entries) {
    const fields = [
      "id",
      "revision",
      "name",
      "summary",
      "notice",
      "tags",
      "endpoint_families",
      "lanes",
      "fallback",
    ];
    if (!exactKeys(
      problems,
      starter,
      label,
      new Set(withRules ? [...fields, "rules", "budget"] : fields),
    )) continue;
    if (withRules) {
      validateRules(problems, starter.rules, `${label}.rules`);
      if (
        starter.budget !== undefined &&
        exactKeys(problems, starter.budget, `${label}.budget`, new Set(["month_usd"])) &&
        !(typeof starter.budget.month_usd === "number" && starter.budget.month_usd > 0 && starter.budget.month_usd <= 10_000_000)
      ) {
        problems.push(`${label}.budget.month_usd must be more than 0 and at most 10,000,000`);
      }
    }

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
