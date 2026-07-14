// The HTTP transport, tested over real loopback sockets with fetch. Every
// scenario here uses the instant profile, so streams complete synchronously
// and no test ever sleeps.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chatRequest, joinContent, parseSse, startServer, tempDir } from "./helpers.mjs";

test("healthz and GET /v1/models answer with the expected shapes", async () => {
  const srv = await startServer({ models: ["stub-large", "stub-mini"] });
  try {
    const health = await srv.get("/healthz");
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.server, "test-stub");
    assert.equal(healthBody.stublm, "0.1.0");
    const res = await srv.get("/v1/models");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.deepEqual(body.data.map((m) => m.id), ["stub-large", "stub-mini"]);
  } finally {
    await srv.close();
  }
});

test("POST /v1/chat/completions serves a scripted non-streaming reply", async () => {
  const srv = await startServer({
    rules: [{ label: "greet", when: { lastUser: { contains: "hello" } }, reply: "Hi there!" }],
  });
  try {
    const res = await srv.post("/v1/chat/completions", chatRequest("hello server"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-stublm-rule"), "greet");
    assert.match(res.headers.get("x-request-id"), /^req_[0-9a-f]{24}$/);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "Hi there!");
  } finally {
    await srv.close();
  }
});

test("streaming responses are well-formed SSE ending in [DONE]", async () => {
  const text = "A streamed reply that spans several chunks for the SSE test.";
  const srv = await startServer({ rules: [{ reply: text }] });
  try {
    const res = await srv.post("/v1/chat/completions", chatRequest("stream it", { stream: true }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/event-stream/);
    const { payloads, done } = parseSse(await res.text());
    assert.ok(done, "missing [DONE] sentinel");
    assert.ok(payloads.length > 3);
    assert.ok(payloads.every((p) => p.object === "chat.completion.chunk"));
    assert.equal(joinContent(payloads), text);
  } finally {
    await srv.close();
  }
});

test("identical request sequences to fresh servers are byte-identical", async () => {
  // Determinism is per session: ids fold in the per-server call counter, so
  // the honest comparison is the same sequence against two fresh servers.
  const scenario = { rules: [{ reply: "determinism check, seed {{seed}}, call {{call}}" }] };
  const request = chatRequest("same twice", { stream: true, seed: 77 });
  const bodies = [];
  for (let i = 0; i < 2; i++) {
    const srv = await startServer(scenario);
    try {
      bodies.push(await (await srv.post("/v1/chat/completions", request)).text());
      bodies.push(await (await srv.post("/v1/chat/completions", request)).text());
    } finally {
      await srv.close();
    }
  }
  assert.equal(bodies[0], bodies[2], "first calls should match across servers");
  assert.equal(bodies[1], bodies[3], "second calls should match across servers");
  assert.notEqual(bodies[0], bodies[1], "the call counter advances within a session");
});

test("scripted errors surface as HTTP status + retry-after header", async () => {
  const srv = await startServer({
    rules: [
      {
        label: "limit",
        times: 1,
        error: { status: 429, message: "scripted", code: "rate_limit_exceeded", retryAfterSeconds: 3 },
      },
    ],
    fallback: { mode: "echo" },
  });
  try {
    const first = await srv.post("/v1/chat/completions", chatRequest("retry me"));
    assert.equal(first.status, 429);
    assert.equal(first.headers.get("retry-after"), "3");
    assert.equal((await first.json()).error.code, "rate_limit_exceeded");
    const second = await srv.post("/v1/chat/completions", chatRequest("retry me"));
    assert.equal(second.status, 200);
    assert.equal((await second.json()).choices[0].message.content, "retry me");
  } finally {
    await srv.close();
  }
});

test("bearer auth: missing and wrong keys 401, the right key passes", async () => {
  const srv = await startServer({ server: { name: "locked", apiKey: "secret-key" } });
  try {
    const missing = await srv.post("/v1/chat/completions", chatRequest("x"));
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, "invalid_api_key");
    const wrong = await srv.post("/v1/chat/completions", chatRequest("x"), {
      authorization: "Bearer nope",
    });
    assert.equal(wrong.status, 401);
    const right = await srv.post("/v1/chat/completions", chatRequest("x"), {
      authorization: "Bearer secret-key",
    });
    assert.equal(right.status, 200);
  } finally {
    await srv.close();
  }
});

test("the x-stublm-profile header overrides timing; unknown names 400", async () => {
  const srv = await startServer({
    profiles: { glacial: { ttftMs: 60000, interChunkMs: 1000, jitterMs: 0 } },
    rules: [{ profile: "glacial", reply: "would be slow" }],
  });
  try {
    // Overriding to instant means this returns immediately — the test itself
    // is the proof, since a glacial stream would blow the runner's timeout.
    const fast = await srv.post(
      "/v1/chat/completions",
      chatRequest("x", { stream: true }),
      { "x-stublm-profile": "instant" }
    );
    assert.equal(fast.status, 200);
    const { done } = parseSse(await fast.text());
    assert.ok(done);
    const bad = await srv.post("/v1/chat/completions", chatRequest("x"), {
      "x-stublm-profile": "warp",
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "stublm_unknown_profile");
  } finally {
    await srv.close();
  }
});

test("POST /v1/embeddings works end to end", async () => {
  const srv = await startServer({ options: { embeddingDims: 8 } });
  try {
    const res = await srv.post("/v1/embeddings", { model: "stub-embed", input: ["a", "b"] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0].embedding.length, 8);
  } finally {
    await srv.close();
  }
});

test("malformed JSON bodies get a 400, unknown paths a 404", async () => {
  const srv = await startServer();
  try {
    const badJson = await srv.post("/v1/chat/completions", "{ nope");
    assert.equal(badJson.status, 400);
    assert.match((await badJson.json()).error.message, /not valid JSON/);
    const notFound = await srv.get("/v1/fine-tuning/jobs");
    assert.equal(notFound.status, 404);
    assert.match((await notFound.json()).error.message, /Unknown request URL/);
  } finally {
    await srv.close();
  }
});

test("CORS headers appear when enabled and OPTIONS preflight is a 204", async () => {
  const withCors = await startServer();
  try {
    const res = await withCors.get("/healthz");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const preflight = await fetch(withCors.base + "/v1/chat/completions", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
  } finally {
    await withCors.close();
  }
  const noCors = await startServer({ options: { cors: false } });
  try {
    const res = await noCors.get("/healthz");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await noCors.close();
  }
});

test("--record appends one JSONL line per handled request", async () => {
  const recordPath = join(tempDir("record"), "trail.jsonl");
  const srv = await startServer(
    { models: ["stub-a"], fallback: { mode: "echo" } },
    { recordPath }
  );
  try {
    await srv.get("/v1/models");
    await srv.post("/v1/chat/completions", chatRequest("logged", { model: "stub-a" }));
    await srv.get("/definitely/not/an/endpoint");
    const lines = readFileSync(recordPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3]);
    assert.equal(lines[0].endpoint, "models");
    assert.equal(lines[1].endpoint, "chat.completions");
    assert.equal(lines[1].status, 200);
    assert.equal(lines[2].status, 404);
  } finally {
    await srv.close();
  }
});
