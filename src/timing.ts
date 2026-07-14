/**
 * Chunk-timing profiles: the "realistic SSE timing" half of stublm. A
 * profile is turned into a *plan* — an array of millisecond delays, one per
 * chunk — by a pure function over a seeded RNG, so the pacing itself is
 * deterministic and unit-testable without ever sleeping. Only the HTTP
 * server actually waits; tests and the `reply` command just read the plan.
 */

import { Rng } from "./rng.js";
import type { TimingProfile } from "./types.js";

/** Built-in profiles. Scenario-defined profiles are merged over these. */
export const BUILTIN_PROFILES: Record<string, TimingProfile> = {
  /** Everything at once — the CI default; no wall-clock time is spent. */
  instant: { ttftMs: 0, interChunkMs: 0, jitterMs: 0 },
  /** A well-behaved hosted model: noticeable TTFT, even flow. */
  steady: { ttftMs: 300, interChunkMs: 24, jitterMs: 8 },
  /** Slow, even, one-piece-at-a-time — good for eyeballing UI rendering. */
  typewriter: { ttftMs: 150, interChunkMs: 45, jitterMs: 0 },
  /** Chunks arrive in bursts with long gaps — the hardest case for UIs. */
  bursty: {
    ttftMs: 500,
    interChunkMs: 5,
    jitterMs: 4,
    burst: { size: 4, pauseMs: 180 },
  },
};

/**
 * Compute the delay (ms) that precedes each of `chunkCount` chunks.
 * delays[0] is the TTFT. Jitter is drawn from `rng`, so a fixed seed gives
 * a fixed plan. Burst profiles pause every `burst.size` chunks.
 */
export function schedule(
  profile: TimingProfile,
  chunkCount: number,
  rng: Rng
): number[] {
  const delays: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    if (i === 0) {
      delays.push(profile.ttftMs);
      continue;
    }
    let delay = profile.interChunkMs;
    if (profile.burst !== undefined && i % profile.burst.size === 0) {
      delay += profile.burst.pauseMs;
    }
    if (profile.jitterMs > 0) {
      delay += rng.int(0, profile.jitterMs);
    }
    delays.push(delay);
  }
  return delays;
}

/** Total planned duration of a schedule, in milliseconds. */
export function totalDuration(delays: number[]): number {
  let total = 0;
  for (const d of delays) {
    total += d;
  }
  return total;
}

/**
 * Resolve a profile name against user profiles + built-ins. The loader
 * guarantees every name referenced by a scenario resolves; the request-level
 * override (`x-stublm-profile` header) goes through here too and may miss.
 */
export function resolveProfile(
  name: string,
  userProfiles: Record<string, TimingProfile>
): TimingProfile | null {
  const user = userProfiles[name];
  if (user !== undefined) {
    return user;
  }
  const builtin = BUILTIN_PROFILES[name];
  return builtin !== undefined ? builtin : null;
}
