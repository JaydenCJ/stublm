/**
 * Server-Sent Events encoding, exactly the way OpenAI's streaming API
 * frames it: one `data: <json>` line per chunk, a blank line between
 * events, and a final `data: [DONE]` sentinel. Comments (`: …`) are used
 * by the CLI's `--show-timing` mode to annotate the planned delays without
 * breaking well-behaved SSE parsers.
 */

import type { CompletionOutcome, JsonObject } from "./types.js";

/** One SSE frame carrying a JSON payload. */
export function encodeEvent(payload: JsonObject): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The terminal sentinel frame. */
export function encodeDone(): string {
  return "data: [DONE]\n\n";
}

/** An SSE comment line (ignored by spec-compliant parsers). */
export function encodeComment(text: string): string {
  return `: ${text}\n`;
}

/**
 * Render a streaming completion as the full list of SSE frames, in order,
 * ending with [DONE]. With `showTiming`, each frame is preceded by a
 * comment carrying its planned delay — handy for eyeballing a profile
 * without waiting for it.
 */
export function streamFrames(
  outcome: CompletionOutcome,
  options: { showTiming?: boolean } = {}
): string[] {
  const frames: string[] = [];
  outcome.chunks.forEach((chunk, i) => {
    if (options.showTiming === true) {
      frames.push(encodeComment(`+${outcome.delays[i] ?? 0}ms`));
    }
    frames.push(encodeEvent(chunk));
  });
  frames.push(encodeDone());
  return frames;
}
