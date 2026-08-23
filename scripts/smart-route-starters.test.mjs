import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateSmartRouteStarters } from "./smart-route-starters.mjs";

function artifact() {
  return {
    schema_version: 1,
    generated_at: "2026-08-23T00:00:00Z",
    locale: "en",
    collections: [
      {
        id: "featured",
        title: "Featured starters",
        description: "I want a useful starting point.",
        starters: ["daily-work"],
      },
    ],
    starters: [
      {
        id: "daily-work",
        revision: 1,
        name: "Daily Work",
        summary: "I want one route for daily work.",
        tags: ["general"],
        endpoint_families: ["openai.responses"],
        lanes: [
          {
            id: "quick-help",
            name: "Quick help",
            description: "I need a short answer.",
            target_hint: "I want a fast target.",
          },
          {
            id: "deep-work",
            name: "Deep work",
            description: "I need a difficult problem worked through.",
            target_hint: "I want a reasoning target.",
          },
        ],
        fallback: { target_hint: "I want a dependable target." },
      },
    ],
  };
}

test("accepts a model-neutral first-person starter catalog", () => {
  assert.deepEqual(validateSmartRouteStarters(artifact()), []);
});

test("the committed starter catalog is valid and model-neutral", async () => {
  const committed = JSON.parse(
    await readFile(new URL("../v1/smart-route-starters.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(validateSmartRouteStarters(committed), []);
});

test("rejects model bindings and unsupported endpoints", () => {
  const input = artifact();
  input.starters[0].fallbackModelId = "provider/model";
  input.starters[0].endpoint_families = ["openai.embeddings"];
  const problems = validateSmartRouteStarters(input);
  assert.ok(problems.some((problem) => problem.includes("unsupported field fallbackModelId")));
  assert.ok(problems.some((problem) => problem.includes("must not bind a starter to a model")));
  assert.ok(problems.some((problem) => problem.includes("unsupported endpoint")));
});

test("rejects non-first-person and oversized classifier copy", () => {
  const input = artifact();
  input.starters[0].summary = "Routes daily work.";
  input.starters[0].lanes[0].description = `I ${"x".repeat(512)}`;
  const problems = validateSmartRouteStarters(input);
  assert.ok(problems.some((problem) => problem.includes("must use first-person copy")));
  assert.ok(problems.some((problem) => problem.includes("longer than 512 bytes")));
});

test("rejects missing references and duplicate lane ids", () => {
  const input = artifact();
  input.collections[0].starters = ["missing"];
  input.starters[0].lanes[1].id = "quick-help";
  const problems = validateSmartRouteStarters(input);
  assert.ok(problems.some((problem) => problem.includes("missing starter missing")));
  assert.ok(problems.some((problem) => problem.includes("duplicates quick-help")));
});
