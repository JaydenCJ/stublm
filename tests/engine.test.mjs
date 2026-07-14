// The stub engine, driven in-process (no sockets). Covers rule selection,
// determinism, streaming chunk assembly, tool calls, times budgets, errors,
// fallbacks, usage accounting, embeddings and the request log.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXED_EPOCH } from "../dist/index.js";
import { chatRequest, makeEngine } from "./helpers.mjs";

test("a matched rule serves its scripted text at the frozen created epoch", () => {
  const engine = makeEngine({
    rules: [{ label: "greet", when: { lastUser: { contains: "hi" } }, reply: "Hello!" }],
  });
  const outcome = engine.chat(chatRequest("hi there"));
  assert.equal(outcome.kind, "completion");
  assert.equal(outcome.ruleRef, "greet");
  assert.equal(outcome.response.created, FIXED_EPOCH);
  const choice = outcome.response.choices[0];
  assert.equal(choice.message.role, "assistant");
  assert.equal(choice.message.content, "Hello!");
  assert.equal(choice.finish_reason, "stop");
  // Rules are tried in order: the first match wins.
  const ordered = makeEngine({
    rules: [
      { label: "first", when: { lastUser: { contains: "x" } }, reply: "one" },
      { label: "second", when: { lastUser: { contains: "x" } }, reply: "two" },
    ],
  });
  assert.equal(ordered.chat(chatRequest("x marks the spot")).ruleRef, "first");
});

test("determinism: same request + seed is byte-identical, ids included", () => {
  const engine = makeEngine();
  const request = chatRequest("tell me something", { seed: 99 });
  const a = engine.chat(request);
  engine.reset();
  const b = engine.chat(request);
  assert.equal(JSON.stringify(a.response), JSON.stringify(b.response));
  assert.match(a.response.id, /^chatcmpl-[0-9a-f]{24}$/);
  assert.match(a.requestId, /^req_[0-9a-f]{24}$/);
  assert.equal(a.requestId, b.requestId);
  // Without an explicit seed, the seed derives from the request content.
  const c = engine.chat(chatRequest("question A")).response;
  const d = engine.chat(chatRequest("question B")).response;
  engine.reset();
  const c2 = engine.chat(chatRequest("question A")).response;
  assert.equal(c.choices[0].message.content, c2.choices[0].message.content);
  assert.notEqual(c.choices[0].message.content, d.choices[0].message.content);
});

test("templates expand message/model/call/seed/server.name per request", () => {
  const engine = makeEngine({
    rules: [{ reply: "call {{call}} on {{server.name}}: {{message}} ({{model}}, seed {{seed}})" }],
  });
  const outcome = engine.chat(chatRequest("ping", { seed: 5 }));
  assert.equal(
    outcome.response.choices[0].message.content,
    "call 1 on test-stub: ping (stub-model, seed 5)"
  );
  const second = engine.chat(chatRequest("ping", { seed: 5 }));
  assert.match(second.response.choices[0].message.content, /^call 2 /);
});

test("times budgets exhaust, then fall through to the next rule", () => {
  const engine = makeEngine({
    rules: [
      { label: "twice", times: 2, reply: "limited" },
      { label: "after", reply: "fallthrough" },
    ],
  });
  assert.equal(engine.chat(chatRequest("a")).ruleRef, "twice");
  assert.equal(engine.chat(chatRequest("b")).ruleRef, "twice");
  assert.equal(engine.chat(chatRequest("c")).ruleRef, "after");
});

test("scripted errors carry status, typed body, rule ref and retry-after", () => {
  const engine = makeEngine({
    rules: [
      {
        label: "flaky",
        times: 1,
        error: { status: 429, message: "scripted limit", code: "rate_limit_exceeded", retryAfterSeconds: 7 },
      },
    ],
  });
  const outcome = engine.chat(chatRequest("anything"));
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 429);
  assert.equal(outcome.body.error.message, "scripted limit");
  assert.equal(outcome.body.error.type, "rate_limit_error");
  assert.equal(outcome.body.error.code, "rate_limit_exceeded");
  assert.equal(outcome.headers["retry-after"], "7");
  assert.equal(outcome.ruleRef, "flaky");
  // The times budget applies to errors too: the retry succeeds.
  assert.equal(engine.chat(chatRequest("anything")).kind, "completion");
  // Default error types when the spec names none: 5xx server_error, 4xx invalid_request_error.
  const typed = makeEngine({
    rules: [
      { when: { lastUser: { equals: "boom" } }, error: { status: 503, message: "down" } },
      { when: { lastUser: { equals: "bad" } }, error: { status: 400, message: "nope" } },
    ],
  });
  assert.equal(typed.chat(chatRequest("boom")).body.error.type, "server_error");
  assert.equal(typed.chat(chatRequest("bad")).body.error.type, "invalid_request_error");
});

test("strictModels 404s unknown models; strictModels false accepts anything", () => {
  const strict = makeEngine({ models: ["stub-a"] });
  const outcome = strict.chat(chatRequest("hi", { model: "gpt-imaginary" }));
  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 404);
  assert.equal(outcome.body.error.code, "model_not_found");
  const loose = makeEngine({ models: ["stub-a"], options: { strictModels: false } });
  assert.equal(loose.chat(chatRequest("hi", { model: "anything" })).kind, "completion");
});

test("request validation: missing model, empty messages, bad n, non-object body", () => {
  const engine = makeEngine();
  const noModel = engine.chat({ messages: [{ role: "user", content: "x" }] });
  assert.equal(noModel.status, 400);
  assert.equal(noModel.body.error.param, "model");
  assert.equal(engine.chat({ model: "m", messages: [] }).body.error.param, "messages");
  assert.equal(engine.chat(chatRequest("x", { n: 0 })).body.error.param, "n");
  assert.equal(engine.chat("just a string").body.error.param, "body");
});

test("fallback modes: generate is seed-stable, echo repeats, reject 404s", () => {
  const generate = makeEngine({ fallback: { mode: "generate", sentences: 2 } });
  const outcome = generate.chat(chatRequest("unmatched", { seed: 3 }));
  assert.equal(outcome.ruleRef, "fallback:generate");
  const text = outcome.response.choices[0].message.content;
  assert.equal(text.split(". ").length, 2);
  generate.reset();
  assert.equal(
    generate.chat(chatRequest("unmatched", { seed: 3 })).response.choices[0].message.content,
    text
  );
  const echo = makeEngine({ fallback: { mode: "echo" } });
  assert.equal(
    echo.chat(chatRequest("echo this back")).response.choices[0].message.content,
    "echo this back"
  );
  const reject = makeEngine({ fallback: { mode: "reject" } });
  const rejected = reject.chat(chatRequest("no rule for me"));
  assert.equal(rejected.kind, "error");
  assert.equal(rejected.status, 404);
  assert.equal(rejected.body.error.code, "stublm_no_rule_matched");
  assert.equal(rejected.ruleRef, "fallback:reject");
});

test("max_tokens truncates with finish_reason length; max_completion_tokens wins", () => {
  const engine = makeEngine({ rules: [{ reply: "one two three four five six seven" }] });
  const truncated = engine.chat(chatRequest("x", { max_tokens: 3 }));
  assert.equal(truncated.response.choices[0].finish_reason, "length");
  assert.equal(truncated.response.usage.completion_tokens, 3);
  assert.ok(
    truncated.response.choices[0].message.content.length <
      "one two three four five six seven".length
  );
  const precedence = engine.chat(chatRequest("x", { max_tokens: 100, max_completion_tokens: 2 }));
  assert.equal(precedence.response.usage.completion_tokens, 2);
});

test("n > 1 yields n distinct indexed choices and summed usage", () => {
  const engine = makeEngine({ fallback: { mode: "generate", sentences: 1 } });
  const outcome = engine.chat(chatRequest("variants please", { n: 3, seed: 8 }));
  const choices = outcome.response.choices;
  assert.equal(choices.length, 3);
  assert.deepEqual(choices.map((c) => c.index), [0, 1, 2]);
  // Choices are seeded per index, so they differ.
  assert.notEqual(choices[0].message.content, choices[1].message.content);
  assert.equal(
    outcome.response.usage.total_tokens,
    outcome.response.usage.prompt_tokens + outcome.response.usage.completion_tokens
  );
});

test("tool-call replies serialize arguments and default to tool_calls finish", () => {
  const engine = makeEngine({
    rules: [
      {
        reply: {
          toolCalls: [{ name: "get_weather", arguments: { city: "Osaka", unit: "c" } }],
        },
      },
    ],
  });
  const outcome = engine.chat(chatRequest("weather?"));
  const message = outcome.response.choices[0].message;
  assert.equal(message.content, null, "content is null for pure tool-call replies");
  assert.equal(message.tool_calls.length, 1);
  const call = message.tool_calls[0];
  assert.match(call.id, /^call_[0-9a-f]{16}$/);
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "get_weather");
  assert.deepEqual(JSON.parse(call.function.arguments), { city: "Osaka", unit: "c" });
  assert.equal(outcome.response.choices[0].finish_reason, "tool_calls");
  // String arguments pass through verbatim — malformed JSON is a feature,
  // for testing how clients cope with a model that emits broken arguments.
  const verbatim = makeEngine({
    rules: [{ reply: { toolCalls: [{ name: "t", arguments: '{"broken":' }] } }],
  });
  assert.equal(
    verbatim.chat(chatRequest("x")).response.choices[0].message.tool_calls[0].function.arguments,
    '{"broken":'
  );
});

test("streaming chunks reassemble to exactly the non-streaming content", () => {
  const text = "A reasonably long scripted reply, with punctuation — and unicode: 日本語.";
  const engine = makeEngine({ rules: [{ reply: text }] });
  const outcome = engine.chat(chatRequest("x", { stream: true }));
  assert.equal(outcome.stream, true);
  assert.ok(outcome.chunks.length > 3);
  assert.equal(outcome.chunks.length, outcome.delays.length);
  assert.equal(outcome.chunks[0].choices[0].delta.role, "assistant");
  let joined = "";
  let finish = null;
  for (const chunk of outcome.chunks) {
    assert.equal(chunk.object, "chat.completion.chunk");
    const choice = chunk.choices[0];
    if (choice.delta.content) joined += choice.delta.content;
    if (choice.finish_reason !== null) finish = choice.finish_reason;
  }
  assert.equal(joined, text);
  assert.equal(finish, "stop");
  // usage is identical between the streaming and non-streaming paths.
  const plain = makeEngine({ rules: [{ reply: text }] }).chat(chatRequest("x", { seed: 2 }));
  assert.deepEqual(plain.response.usage, outcome.response.usage);
});

test("stream_options.include_usage appends a final usage-only chunk", () => {
  const engine = makeEngine({ rules: [{ reply: "count me" }] });
  const outcome = engine.chat(
    chatRequest("x", { stream: true, stream_options: { include_usage: true } })
  );
  const last = outcome.chunks[outcome.chunks.length - 1];
  assert.deepEqual(last.choices, []);
  assert.equal(last.usage.total_tokens, last.usage.prompt_tokens + last.usage.completion_tokens);
  const without = makeEngine({ rules: [{ reply: "count me" }] }).chat(
    chatRequest("x", { stream: true })
  );
  assert.equal(without.chunks.length, outcome.chunks.length - 1);
});

test("streamed tool calls: header chunk with id/name, then argument deltas", () => {
  const engine = makeEngine({
    rules: [{ reply: { toolCalls: [{ name: "lookup", arguments: { q: "deterministic stubs" } }] } }],
  });
  const outcome = engine.chat(chatRequest("x", { stream: true }));
  const toolChunks = outcome.chunks.filter((c) => c.choices[0]?.delta.tool_calls !== undefined);
  assert.ok(toolChunks.length >= 2);
  const header = toolChunks[0].choices[0].delta.tool_calls[0];
  assert.equal(header.function.name, "lookup");
  assert.equal(header.function.arguments, "");
  assert.match(header.id, /^call_/);
  const args = toolChunks
    .slice(1)
    .map((c) => c.choices[0].delta.tool_calls[0].function.arguments)
    .join("");
  assert.deepEqual(JSON.parse(args), { q: "deterministic stubs" });
});

test("stream delays follow the rule's profile; overrides beat it; unknowns 400", () => {
  const engine = makeEngine({
    profiles: { fixedpace: { ttftMs: 500, interChunkMs: 25, jitterMs: 0 } },
    rules: [{ profile: "fixedpace", reply: "several words to make chunks" }],
  });
  const paced = engine.chat(chatRequest("x", { seed: 1, stream: true }));
  assert.equal(paced.profileName, "fixedpace");
  assert.equal(paced.delays[0], 500);
  assert.ok(paced.delays.slice(1).every((d) => d === 25));
  const overridden = engine.chat(chatRequest("x", { stream: true }), {
    profileOverride: "instant",
  });
  assert.equal(overridden.profileName, "instant");
  assert.ok(overridden.delays.every((d) => d === 0));
  const unknown = engine.chat(chatRequest("x"), { profileOverride: "warp" });
  assert.equal(unknown.kind, "error");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, "stublm_unknown_profile");
});

test("models() lists scenario models with owned_by stublm", () => {
  const engine = makeEngine({ models: ["stub-a", "stub-b"] });
  const body = engine.models();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((m) => m.id), ["stub-a", "stub-b"]);
  assert.ok(body.data.every((m) => m.owned_by === "stublm"));
});

test("embeddings: seeded vectors, per-input index, usage totals", () => {
  const engine = makeEngine({ models: ["stub-embed"], options: { embeddingDims: 16 } });
  const outcome = engine.embeddings({ model: "stub-embed", input: ["alpha", "beta", "alpha"] });
  assert.equal(outcome.kind, "embeddings");
  const data = outcome.response.data;
  assert.equal(data.length, 3);
  assert.deepEqual(data.map((d) => d.index), [0, 1, 2]);
  assert.equal(data[0].embedding.length, 16);
  assert.deepEqual(data[0].embedding, data[2].embedding, "equal strings embed identically");
  assert.notDeepEqual(data[0].embedding, data[1].embedding);
  assert.equal(outcome.response.usage.prompt_tokens, outcome.response.usage.total_tokens);
});

test("embeddings: request dimensions override the default; bad shapes 400", () => {
  const engine = makeEngine({ models: ["stub-embed"], options: { embeddingDims: 16 } });
  const outcome = engine.embeddings({ model: "stub-embed", input: "x", dimensions: 4 });
  assert.equal(outcome.response.data[0].embedding.length, 4);
  const badDims = engine.embeddings({ model: "stub-embed", input: "x", dimensions: 0 });
  assert.equal(badDims.kind, "error");
  assert.equal(badDims.body.error.param, "dimensions");
  const badInput = engine.embeddings({ model: "stub-embed", input: [1, 2] });
  assert.equal(badInput.status, 400);
  assert.equal(badInput.body.error.param, "input");
});

test("the request log records every call in order with seq numbers", () => {
  const engine = makeEngine({
    models: ["stub-a"],
    rules: [{ label: "flaky", times: 1, error: { status: 500, message: "boom" } }],
  });
  engine.models();
  engine.chat(chatRequest("first", { model: "stub-a" }));
  engine.chat(chatRequest("second", { model: "stub-a", stream: true }));
  engine.noteUnmatched("GET", "/nope");
  assert.deepEqual(engine.log.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(engine.log[0].endpoint, "models");
  assert.equal(engine.log[1].status, 500);
  assert.equal(engine.log[1].rule, "flaky");
  assert.equal(engine.log[2].stream, true);
  assert.ok(engine.log[2].promptTokens > 0);
  assert.equal(engine.log[3].endpoint, "GET /nope");
  engine.reset();
  assert.equal(engine.log.length, 0);
});
