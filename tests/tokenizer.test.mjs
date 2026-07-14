// The approximate tokenizer. Its one hard invariant — pieces(text) always
// concatenates back to text — is what guarantees streamed deltas reassemble
// into exactly the scripted reply, so it gets hammered here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countMessageTokens, countTokens, pieces } from "../dist/index.js";

const ROUND_TRIP_CASES = [
  "",
  "hi",
  "hello world",
  "  leading spaces",
  "trailing spaces  ",
  "a  double  spaced  line",
  "supercalifragilisticexpialidocious",
  "tabs\tand\nnewlines\r\nmixed",
  '{"json":"payload","n":42}',
  "unicode: 日本語のテキストと絵文字 🎉 が混ざる",
  "   ",
];

test("pieces round-trips every representative input", () => {
  for (const text of ROUND_TRIP_CASES) {
    assert.equal(pieces(text).join(""), text, JSON.stringify(text));
  }
});

test("edge shapes: empty string is [], pure whitespace is one piece", () => {
  assert.deepEqual(pieces(""), []);
  assert.deepEqual(pieces("   "), ["   "]);
});

test("short words stay whole; long words split; whitespace leads the next piece", () => {
  assert.deepEqual(pieces("a b"), ["a", " b"]);
  assert.deepEqual(pieces("abcdefghij"), ["abcd", "efgh", "ij"]);
  assert.deepEqual(pieces("hi there"), ["hi", " ther", "e"]);
  // Whitespace attaches to the piece that FOLLOWS it, like real SSE deltas.
  const parts = pieces("one two three");
  assert.equal(parts[0], "one");
  assert.ok(parts[1].startsWith(" "), `expected leading space in ${JSON.stringify(parts[1])}`);
});

test("countTokens is 0 only for empty text and grows with length", () => {
  assert.equal(countTokens(""), 0);
  assert.ok(countTokens("x") > 0);
  assert.ok(countTokens("a much longer sentence with many words") > countTokens("short"));
});

test("countMessageTokens adds per-message overhead plus reply priming", () => {
  // 3 (priming) + per message: 4 + content tokens.
  assert.equal(countMessageTokens([]), 3);
  assert.equal(countMessageTokens([{ role: "user", text: "" }]), 7);
  assert.equal(countMessageTokens([{ role: "user", text: "hi" }]), 7 + countTokens("hi"));
});

test("countMessageTokens is order-independent for the same content", () => {
  const a = countMessageTokens([
    { role: "system", text: "be brief" },
    { role: "user", text: "hello" },
  ]);
  const b = countMessageTokens([
    { role: "user", text: "hello" },
    { role: "system", text: "be brief" },
  ]);
  assert.equal(a, b);
});
