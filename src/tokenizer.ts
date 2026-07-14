/**
 * A deterministic approximate tokenizer. It is NOT a BPE — it exists so
 * that (a) streamed deltas concatenate back to the exact reply text, and
 * (b) `usage` numbers are stable, plausible, and consistent between the
 * streaming and non-streaming paths. Long words are split into ~4-char
 * pieces to mimic subword tokenization; whitespace stays attached to the
 * piece that follows it, matching how real SSE deltas look.
 */

const MAX_PIECE = 4;

/**
 * Split text into stream-ready pieces. Invariant (pinned by tests):
 * `pieces(text).join("") === text` for every input.
 */
export function pieces(text: string): string[] {
  const out: string[] = [];
  // Each run = optional leading whitespace + a maximal non-space word.
  const runs = text.match(/\s*\S+/g);
  if (runs === null) {
    return text.length > 0 ? [text] : [];
  }
  let consumed = 0;
  for (const run of runs) {
    consumed += run.length;
    const wsEnd = run.length - run.replace(/^\s+/, "").length;
    const ws = run.slice(0, wsEnd);
    const word = run.slice(wsEnd);
    if (word.length <= MAX_PIECE) {
      out.push(ws + word);
      continue;
    }
    // First piece keeps the whitespace; the rest are 4-char slices.
    out.push(ws + word.slice(0, MAX_PIECE));
    for (let i = MAX_PIECE; i < word.length; i += MAX_PIECE) {
      out.push(word.slice(i, i + MAX_PIECE));
    }
  }
  // Trailing whitespace (no word after it) must still round-trip.
  if (consumed < text.length) {
    out.push(text.slice(consumed));
  }
  return out;
}

/** Token count of a plain string. */
export function countTokens(text: string): number {
  return pieces(text).length;
}

/**
 * Token count of a message list, OpenAI-chat style: every message costs a
 * small fixed overhead (role + framing) plus its content tokens, and the
 * reply is primed with a constant. An approximation, but a *stable* one.
 */
export function countMessageTokens(
  messages: { role: string; text: string }[]
): number {
  let total = 3; // reply priming
  for (const message of messages) {
    total += 4 + countTokens(message.text);
  }
  return total;
}
