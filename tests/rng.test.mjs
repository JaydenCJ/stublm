// The deterministic-randomness primitives. Everything downstream (ids,
// jitter, generated prose, embeddings) leans on these being stable across
// runs and platforms, so exact values are pinned here on purpose.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Rng, fnv1a, hexId, mixSeed } from "../dist/index.js";

test("fnv1a matches reference values and distinguishes nearby strings", () => {
  // Classic FNV-1a 32-bit reference values.
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("hello"), 0x4f9f2cab);
  assert.notEqual(fnv1a("stub-large"), fnv1a("stub-mini"));
  assert.notEqual(fnv1a("ab"), fnv1a("ba"));
});

test("mixSeed is stable per input pair and order-sensitive", () => {
  assert.equal(mixSeed(1, 2), mixSeed(1, 2));
  // Order sensitivity matters: (seed, choiceIndex) and (choiceIndex, seed)
  // must not collide, or different choices could share generated text.
  assert.notEqual(mixSeed(1, 2), mixSeed(2, 1));
  assert.notEqual(mixSeed(0, 1), mixSeed(1, 0));
});

test("Rng yields identical sequences per seed and diverges across seeds", () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  for (let i = 0; i < 100; i++) {
    assert.equal(a.next(), b.next());
  }
  const c = new Rng(1);
  const d = new Rng(2);
  const same = Array.from({ length: 10 }, () => c.next() === d.next());
  assert.ok(same.includes(false), "different seeds should not track each other");
});

test("Rng.next stays in [0,1) and Rng.int hits its inclusive bounds", () => {
  const rng = new Rng(42);
  for (let i = 0; i < 1000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const v = rng.int(3, 5);
    assert.ok(v >= 3 && v <= 5);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5]);
  // pick only ever returns members, and refuses an empty array loudly.
  const items = ["x", "y", "z"];
  for (let i = 0; i < 50; i++) {
    assert.ok(items.includes(rng.pick(items)));
  }
  assert.throws(() => rng.pick([]), /empty/);
});

test("hexId is 24 lowercase hex chars and deterministic per (seed, salt)", () => {
  const id = hexId(123, 456);
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(id, hexId(123, 456));
  assert.notEqual(id, hexId(123, 457));
  assert.notEqual(id, hexId(124, 456));
});
