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
        description: "Useful starting points for daily work.",
        starters: ["daily-work"],
      },
    ],
    starters: [
      {
        id: "daily-work",
        revision: 1,
        name: "Daily Work",
        summary: "Routes common daily work.",
        tags: ["general"],
        endpoint_families: ["openai.responses"],
        lanes: [
          {
            id: "quick-help",
            name: "Quick help",
            description: "Short answers and simple questions.",
            target_hint: "Best with a fast target.",
          },
          {
            id: "deep-work",
            name: "Deep work",
            description: "Difficult problems and multi-step reasoning.",
            target_hint: "Best with a reasoning target.",
          },
        ],
        fallback: { target_hint: "Best with a dependable target." },
      },
    ],
  };
}

test("accepts a model-neutral starter catalog with direct copy", () => {
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

test("rejects first-person and oversized classifier copy", () => {
  const input = artifact();
  input.starters[0].summary = "I want a route for daily work.";
  input.starters[0].lanes[0].description = `A ${"x".repeat(512)}`;
  const problems = validateSmartRouteStarters(input);
  assert.ok(problems.some((problem) => problem.includes("must describe the item directly")));
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

function ruleStarter() {
  const starter = structuredClone(artifact().starters[0]);
  starter.id = "budget";
  starter.name = "Budget";
  starter.rules = [
    {
      id: "over-budget",
      name: "Over 80% of the budget",
      when: [{ fact: "route.spend.monthPercent", op: "gte", value: 80 }],
      then: { target_hint: "Best with a model on this Mac." },
    },
  ];
  starter.budget = { month_usd: 100 };
  return starter;
}

test("accepts a rule starter that names no model", () => {
  const input = artifact();
  input.rule_starters = [ruleStarter()];
  input.collections[0].starters.push("budget");
  assert.deepEqual(validateSmartRouteStarters(input), []);
});

test("rejects rules on a plain starter, a model target, and an unknown fact", () => {
  const input = artifact();
  input.starters[0].rules = ruleStarter().rules;
  const named = ruleStarter();
  named.rules[0].then = { target: "openai/gpt-5" };
  named.rules[0].when[0].fact = "machine.memory";
  input.rule_starters = [named];
  input.collections[0].starters.push("budget");
  const problems = validateSmartRouteStarters(input);
  assert.ok(problems.some((problem) => problem.includes("starters[0] has unsupported field rules")));
  assert.ok(problems.some((problem) => problem.includes("target must be fallback or router")));
  assert.ok(problems.some((problem) => problem.includes("is not a rule fact")));
});

test("a rule names exactly one of target and target_hint", () => {
  const input = artifact();
  const both = ruleStarter();
  both.rules[0].then = { target: "fallback", target_hint: "A model." };
  input.rule_starters = [both];
  input.collections[0].starters.push("budget");
  assert.ok(
    validateSmartRouteStarters(input).some((problem) => problem.includes("exactly one of target and target_hint")),
  );
});
