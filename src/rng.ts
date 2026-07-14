/**
 * Deterministic randomness: a 32-bit FNV-1a hash for turning strings into
 * seeds, and a mulberry32 PRNG for everything that needs to *look* random
 * (generated prose, timing jitter, embedding vectors). No wall clock, no
 * `Math.random` — the same seed always yields the same sequence, which is
 * the whole point of this project.
 */

/** 32-bit FNV-1a. Stable across platforms; used to derive seeds from text. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mix two 32-bit values into a new seed. Order-sensitive: `a` is scrambled
 * by a multiply before `b` enters, so mixSeed(a, b) !== mixSeed(b, a). */
export function mixSeed(a: number, b: number): number {
  let h = Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (b >>> 0), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32 — tiny, fast, and good enough for prose and jitter. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined && items.length === 0) {
      throw new Error("Rng.pick on empty array");
    }
    return item as T;
  }
}

/** Fixed-width lowercase hex of a 32-bit value. */
export function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/**
 * A 24-hex-char identifier derived from a base seed and a salt — used for
 * `chatcmpl-…` ids and request ids. Deterministic per (seed, salt).
 */
export function hexId(seed: number, salt: number): string {
  const a = mixSeed(seed, salt);
  const b = mixSeed(a, 0x51ed270b);
  const c = mixSeed(b, 0x2545f491);
  return hex8(a) + hex8(b) + hex8(c);
}
