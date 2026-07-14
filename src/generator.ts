/**
 * The seeded text generator behind the `generate` fallback: when no rule
 * matches a request, stublm answers with fluent-looking, deterministic
 * filler prose. Same seed, same text — so snapshot tests of "whatever the
 * model said" stay green. The vocabulary is deliberately bland and neutral
 * English; nothing here is a language model.
 */

import { Rng } from "./rng.js";

const OPENERS = [
  "Here is",
  "In short,",
  "Broadly speaking,",
  "To summarize,",
  "From this perspective,",
  "In practice,",
  "As a starting point,",
  "For context,",
];

const SUBJECTS = [
  "the system",
  "this approach",
  "the pipeline",
  "the configuration",
  "each component",
  "the interface",
  "the workflow",
  "the dataset",
  "the request",
  "the response",
];

const VERBS = [
  "handles",
  "describes",
  "produces",
  "combines",
  "validates",
  "organizes",
  "simplifies",
  "coordinates",
  "summarizes",
  "extends",
];

const OBJECTS = [
  "a stable set of results",
  "the relevant details",
  "several distinct stages",
  "a consistent structure",
  "the expected behavior",
  "a clear sequence of steps",
  "the underlying values",
  "a predictable outcome",
  "the remaining edge cases",
  "a compact summary",
];

const TAILS = [
  "without additional overhead",
  "across repeated runs",
  "in a reproducible way",
  "with minimal configuration",
  "for downstream consumers",
  "under normal conditions",
  "as the documentation notes",
  "at every step of the process",
];

/** One deterministic sentence from the given generator state. */
export function generateSentence(rng: Rng): string {
  const parts: string[] = [];
  if (rng.next() < 0.4) {
    parts.push(rng.pick(OPENERS));
  }
  let subject = rng.pick(SUBJECTS);
  if (parts.length === 0) {
    subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  }
  parts.push(subject, rng.pick(VERBS), rng.pick(OBJECTS));
  if (rng.next() < 0.5) {
    parts.push(rng.pick(TAILS));
  }
  return parts.join(" ") + ".";
}

/** N deterministic sentences joined into one paragraph. */
export function generateText(rng: Rng, sentences: number): string {
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    out.push(generateSentence(rng));
  }
  return out.join(" ");
}

/**
 * A deterministic embedding vector for a text: unit-length, `dims` wide,
 * seeded from the input so equal strings embed identically and different
 * strings (almost always) do not.
 */
export function generateEmbedding(seed: number, dims: number): number[] {
  const rng = new Rng(seed);
  const raw: number[] = [];
  let sumSquares = 0;
  for (let i = 0; i < dims; i++) {
    const v = rng.next() * 2 - 1;
    raw.push(v);
    sumSquares += v * v;
  }
  const norm = Math.sqrt(sumSquares) || 1;
  // Round to keep payloads compact; renormalization error is negligible.
  return raw.map((v) => Number((v / norm).toFixed(7)));
}
