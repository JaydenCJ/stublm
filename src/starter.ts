/**
 * The annotated starter scenario written by `stublm init`. It must always
 * validate cleanly (a test pins this) and demonstrate the core spec
 * features: a matched rule, a scripted transient failure, a custom timing
 * profile, and the generate fallback.
 */

export const STARTER_FILENAME = "stublm.stub.json";

export const STARTER_SCENARIO = {
  server: { name: "starter-stub", version: "1.0.0" },
  models: ["stub-large", "stub-mini"],
  options: {
    defaultProfile: "instant",
    clock: "fixed",
    embeddingDims: 32,
    strictModels: true,
    cors: true,
  },
  profiles: {
    "slow-net": { ttftMs: 800, interChunkMs: 40, jitterMs: 20 },
  },
  rules: [
    {
      label: "greeting",
      when: { lastUser: { regex: "\\b([Hh]i|[Hh]ello|[Hh]ey)\\b" } },
      reply: "Hello from {{server.name}}! You said: {{message}}",
    },
    {
      label: "flaky-once",
      when: { lastUser: { contains: "flaky" } },
      times: 1,
      error: {
        status: 429,
        message: "Rate limit reached (scripted; the retry will succeed)",
        code: "rate_limit_exceeded",
        retryAfterSeconds: 1,
      },
    },
    {
      label: "slow-stream",
      when: { model: "stub-mini", stream: true },
      profile: "slow-net",
      reply: "This reply streams over the slow-net profile so UIs can be watched rendering.",
    },
  ],
  fallback: { mode: "generate", sentences: 3 },
};

/** Pretty-printed starter file content. */
export function starterJson(): string {
  return JSON.stringify(STARTER_SCENARIO, null, 2) + "\n";
}
