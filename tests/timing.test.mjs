// Chunk-timing plans. schedule() is pure — delays are computed, never
// slept — so "realistic SSE timing" can be asserted to the millisecond
// without the test suite ever waiting.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_PROFILES,
  Rng,
  resolveProfile,
  schedule,
  totalDuration,
} from "../dist/index.js";

test("the four built-in profiles exist and instant is all-zero", () => {
  assert.deepEqual(
    Object.keys(BUILTIN_PROFILES).sort(),
    ["bursty", "instant", "steady", "typewriter"]
  );
  assert.deepEqual(BUILTIN_PROFILES.instant, { ttftMs: 0, interChunkMs: 0, jitterMs: 0 });
});

test("schedule emits one delay per chunk, TTFT first; zero chunks is empty", () => {
  const profile = { ttftMs: 300, interChunkMs: 20, jitterMs: 0 };
  const delays = schedule(profile, 5, new Rng(1));
  assert.equal(delays.length, 5);
  assert.equal(delays[0], 300);
  assert.deepEqual(delays.slice(1), [20, 20, 20, 20]);
  assert.deepEqual(schedule(profile, 0, new Rng(1)), []);
  assert.equal(totalDuration(delays), 300 + 4 * 20);
  assert.equal(totalDuration([]), 0);
});

test("jitter is bounded by jitterMs and seeded — same seed, same plan", () => {
  const profile = { ttftMs: 100, interChunkMs: 10, jitterMs: 8 };
  const a = schedule(profile, 50, new Rng(42));
  const b = schedule(profile, 50, new Rng(42));
  assert.deepEqual(a, b);
  for (const delay of a.slice(1)) {
    assert.ok(delay >= 10 && delay <= 18, `delay ${delay} outside [10, 18]`);
  }
});

test("different jitter seeds give different plans", () => {
  const profile = { ttftMs: 0, interChunkMs: 10, jitterMs: 50 };
  const a = schedule(profile, 40, new Rng(1));
  const b = schedule(profile, 40, new Rng(2));
  assert.notDeepEqual(a, b);
});

test("burst profiles insert the pause every `size` chunks", () => {
  const profile = { ttftMs: 0, interChunkMs: 5, jitterMs: 0, burst: { size: 3, pauseMs: 100 } };
  const delays = schedule(profile, 8, new Rng(1));
  // Pauses land where i % 3 === 0 (i > 0): chunks 3 and 6.
  assert.deepEqual(delays, [0, 5, 5, 105, 5, 5, 105, 5]);
});

test("resolveProfile: user profiles shadow built-ins, unknown names miss", () => {
  const custom = { ttftMs: 1, interChunkMs: 2, jitterMs: 3 };
  assert.equal(resolveProfile("steady", { steady: custom }), custom);
  assert.equal(resolveProfile("steady", {}), BUILTIN_PROFILES.steady);
  assert.equal(resolveProfile("no-such-profile", {}), null);
});
