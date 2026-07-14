// The seeded fallback generator and embedding vectors. The contract is not
// "good prose" — it is byte-stable output per seed and well-formed vectors.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Rng, generateEmbedding, generateSentence, generateText } from "../dist/index.js";

test("generateSentence is seed-stable, capitalized and ends with a period", () => {
  const a = generateSentence(new Rng(11));
  const b = generateSentence(new Rng(11));
  assert.equal(a, b);
  assert.ok(a.endsWith("."));
  for (const seed of [1, 2, 3, 4, 5, 99, 1000]) {
    assert.match(generateSentence(new Rng(seed)), /^[A-Z]/, `seed ${seed}`);
  }
});

test("generateText produces exactly N sentences, differing across seeds", () => {
  const text = generateText(new Rng(7), 4);
  assert.equal(text.split(". ").length, 4);
  assert.equal(generateText(new Rng(7), 4), text);
  assert.notEqual(generateText(new Rng(1), 3), generateText(new Rng(2), 3));
});

test("generateEmbedding: requested width, unit norm, components in [-1,1]", () => {
  const vector = generateEmbedding(1234, 32);
  assert.equal(vector.length, 32);
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-4, `norm ${norm} not ~1`);
  for (const v of generateEmbedding(99, 256)) {
    assert.ok(v >= -1 && v <= 1);
  }
});

test("generateEmbedding is deterministic per (seed, dims) and varies by seed", () => {
  assert.deepEqual(generateEmbedding(5, 8), generateEmbedding(5, 8));
  assert.notDeepEqual(generateEmbedding(5, 8), generateEmbedding(6, 8));
});
