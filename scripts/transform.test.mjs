// Run: node --test scripts/*.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { checkRegression, serialize, transform } from "./transform.mjs";

const upstream = (models) => ({ acme: { models } });

test("keeps input, output, and the optional rate fields", () => {
  const { providers, counts } = transform(
    upstream({
      "m-1": {
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 200000, output: 64000 },
      },
    }),
  );
  assert.deepEqual(providers.acme["m-1"], {
    input: 5,
    output: 25,
    cache_read: 0.5,
    cache_write: 6.25,
    context: 200000,
    max_output: 64000,
  });
  assert.deepEqual(counts, { providers: 1, models: 1, dropped: 0 });
});

test("drops a model priced on only one side", () => {
  const { providers, counts } = transform(
    upstream({ "m-1": { cost: { input: 5 } } }),
  );
  assert.deepEqual(providers, {});
  assert.equal(counts.dropped, 1);
});

test("drops implausible and malformed rates instead of repairing them", () => {
  for (const cost of [
    { input: -1, output: 5 },
    { input: 5, output: 20_000 },
    { input: "5", output: 5 },
    { input: Number.NaN, output: 5 },
  ]) {
    const { providers, counts } = transform(upstream({ "m-1": { cost } }));
    assert.deepEqual(providers, {}, JSON.stringify(cost));
    assert.equal(counts.dropped, 1, JSON.stringify(cost));
  }
});

test("an unpriced model is absent, not dropped", () => {
  const { providers, counts } = transform(
    upstream({ "m-1": { limit: { context: 8192, output: 4096 } } }),
  );
  assert.deepEqual(providers, {});
  assert.deepEqual(counts, { providers: 0, models: 0, dropped: 0 });
});

test("normalizes context tiers and sorts them ascending", () => {
  const { providers } = transform(
    upstream({
      "m-1": {
        cost: {
          input: 5,
          output: 30,
          tiers: [
            { input: 15, output: 60, tier: { type: "context", size: 500000 } },
            { input: 10, output: 45, tier: { type: "context", size: 272000 } },
          ],
          context_over_200k: { input: 10, output: 45 },
        },
      },
    }),
  );
  assert.deepEqual(providers.acme["m-1"].tiers, [
    { input: 10, output: 45, above_context: 272000 },
    { input: 15, output: 60, above_context: 500000 },
  ]);
  // The legacy duplicate spelling is not republished.
  assert.equal("context_over_200k" in providers.acme["m-1"], false);
});

test("ignores tiers that are not context-sized or not fully priced", () => {
  const { providers } = transform(
    upstream({
      "m-1": {
        cost: {
          input: 5,
          output: 30,
          tiers: [
            { input: 10, output: 45, tier: { type: "throughput", size: 100 } },
            { input: 10, tier: { type: "context", size: 272000 } },
          ],
        },
      },
    }),
  );
  assert.equal("tiers" in providers.acme["m-1"], false);
});

test("drops non-positive and non-integer limits", () => {
  const { providers } = transform(
    upstream({
      "m-1": { cost: { input: 5, output: 25 }, limit: { context: 0, output: 1.5 } },
    }),
  );
  assert.deepEqual(providers.acme["m-1"], { input: 5, output: 25 });
});

test("serializes one line per model with stable ordering", () => {
  const artifact = {
    schema_version: 1,
    generated_at: "2026-08-15T00:00:00Z",
    cost_unit: "usd_per_million_tokens",
    source: { url: "https://models.dev/api.json" },
    counts: { providers: 1, models: 2, dropped: 0 },
    providers: {
      acme: {
        "m-1": { input: 1, output: 2, context: 8192 },
        "m-2": { input: 3, output: 4 },
      },
    },
  };
  const text = serialize(artifact);
  assert.deepEqual(JSON.parse(text), artifact);
  assert.match(text, /\n {6}"m-1": \{"input":1,"output":2,"context":8192\},\n/);
  assert.equal(text.endsWith("}\n"), true);
});

test("serialization is byte-identical across runs", () => {
  const build = () => transform(upstream({ "m-1": { cost: { input: 1, output: 2 } } }));
  const artifact = (body) => ({
    schema_version: 1,
    generated_at: "2026-08-15T00:00:00Z",
    cost_unit: "usd_per_million_tokens",
    source: {},
    ...body,
  });
  assert.equal(serialize(artifact(build())), serialize(artifact(build())));
});

test("regression guard fails an empty or collapsed catalog", () => {
  const previous = { counts: { models: 1000 } };
  assert.deepEqual(
    checkRegression({ candidate: { counts: { models: 900 } }, previous }),
    [],
  );
  assert.equal(
    checkRegression({ candidate: { counts: { models: 100 } }, previous }).length,
    1,
  );
  assert.equal(
    checkRegression({ candidate: { counts: { models: 0 } }, previous }).length,
    2,
  );
  // No previous artifact: only the empty check applies, so a first run cannot
  // be blocked by a floor it has nothing to compare against.
  assert.deepEqual(
    checkRegression({ candidate: { counts: { models: 5 } }, previous: undefined }),
    [],
  );
});
