// Rule matching predicates. These are the routing brain of the stub; every
// clause is exercised, including the "absent clause matches all" defaults
// and the deliberately exact (non-fuzzy) semantics.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lastUserText,
  messageText,
  modelMatches,
  textMatches,
  whenMatches,
} from "../dist/index.js";
import { chatRequest } from "./helpers.mjs";

test("messageText: strings pass through, text parts join, odd content is empty", () => {
  assert.equal(messageText("plain"), "plain");
  assert.equal(
    messageText([
      { type: "text", text: "part one " },
      { type: "image_url", image_url: { url: "https://example.test/x.png" } },
      { type: "text", text: "part two" },
    ]),
    "part one part two"
  );
  assert.equal(messageText(undefined), "");
  assert.equal(messageText(null), "");
  assert.equal(messageText(42), "");
});

test("lastUserText picks the LAST user message; empty when there is none", () => {
  const messages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "an answer" },
    { role: "user", content: "second question" },
  ];
  assert.equal(lastUserText(messages), "second question");
  assert.equal(lastUserText([{ role: "system", content: "be brief" }]), "");
});

test("text matchers are exact, case-sensitive and not fuzzy", () => {
  assert.ok(textMatches({ equals: "Hello" }, "Hello"));
  assert.ok(!textMatches({ equals: "Hello" }, "hello"));
  assert.ok(!textMatches({ equals: "Hello" }, "Hello!"));
  assert.ok(textMatches({ contains: "refund" }, "I want a refund now"));
  assert.ok(!textMatches({ contains: "refund" }, "REFUND"));
  // Regexes compile the scenario pattern verbatim, anchors included.
  assert.ok(textMatches({ regex: "\\b(hi|hello)\\b" }, "well hello there"));
  assert.ok(!textMatches({ regex: "^hello$" }, "well hello there"));
});

test("modelMatches: exact ids and trailing-* globs only", () => {
  assert.ok(modelMatches("stub-large", "stub-large"));
  assert.ok(!modelMatches("stub-large", "stub-large-2"));
  assert.ok(modelMatches("stub-*", "stub-mini"));
  assert.ok(!modelMatches("stub-*", "other-stub"));
  assert.ok(modelMatches("*", "anything-at-all"));
});

test("whenMatches: absent/empty when matches all; clauses AND together", () => {
  assert.ok(whenMatches(undefined, chatRequest("anything")));
  assert.ok(whenMatches({}, chatRequest("anything")));
  const when = { model: "stub-*", lastUser: { contains: "hi" } };
  assert.ok(whenMatches(when, chatRequest("hi", { model: "stub-mini" })));
  assert.ok(!whenMatches(when, chatRequest("hi", { model: "other" })));
  assert.ok(!whenMatches(when, chatRequest("bye", { model: "stub-mini" })));
});

test("the system clause sees all system messages concatenated", () => {
  const request = {
    model: "m",
    messages: [
      { role: "system", content: "you are a" },
      { role: "system", content: "helpful bot" },
      { role: "user", content: "hi" },
    ],
  };
  assert.ok(whenMatches({ system: { contains: "helpful" } }, request));
  assert.ok(!whenMatches({ system: { contains: "hostile" } }, request));
});

test("hasTool inspects declared function tools, skipping malformed entries", () => {
  const request = chatRequest("check the weather", {
    tools: [
      { type: "function", function: { name: "get_weather", parameters: {} } },
      "not-an-object",
    ],
  });
  assert.ok(whenMatches({ hasTool: "get_weather" }, request));
  assert.ok(!whenMatches({ hasTool: "send_email" }, request));
  assert.ok(!whenMatches({ hasTool: "get_weather" }, chatRequest("no tools here")));
});

test("the stream clause distinguishes streaming from plain requests", () => {
  assert.ok(whenMatches({ stream: true }, chatRequest("x", { stream: true })));
  assert.ok(!whenMatches({ stream: true }, chatRequest("x")));
  assert.ok(whenMatches({ stream: false }, chatRequest("x")));
  assert.ok(!whenMatches({ stream: false }, chatRequest("x", { stream: true })));
});
