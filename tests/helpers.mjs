// Shared test helpers: scenario factories, an in-process engine constructor,
// a loopback HTTP server harness, and a synchronous CLI runner. Deterministic
// throughout — fresh temp dirs, fixed seeds, 127.0.0.1 only, no sleeps.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StubEngine, parseScenario, serve } from "../dist/index.js";

export const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
export const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));

/** A minimal valid raw scenario; override/extend per test. */
export function rawScenario(overrides = {}) {
  return {
    server: { name: "test-stub", version: "9.9.9" },
    ...overrides,
  };
}

/** Parse a raw scenario (throwing on issues) and wrap it in an engine. */
export function makeEngine(overrides = {}) {
  const { scenario } = parseScenario(rawScenario(overrides));
  return new StubEngine(scenario);
}

/** A chat request with sensible defaults. */
export function chatRequest(message, overrides = {}) {
  return {
    model: "stub-model",
    messages: [{ role: "user", content: message }],
    ...overrides,
  };
}

/** Run the built CLI synchronously; returns { status, stdout, stderr }. */
export function runCli(args, { input, cwd } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input: input ?? "",
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A fresh temp dir for the calling test file. */
export function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `stublm-${label}-`));
}

/** Write a scenario object to a temp file and return its path. */
export function writeScenarioFile(dir, scenario, name = "scenario.stub.json") {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(scenario, null, 2));
  return path;
}

/**
 * Start a loopback stub server on an ephemeral port. Returns helpers bound
 * to that port plus `close()`; callers must await close() in a finally.
 */
export async function startServer(overrides = {}, serveOptions = {}) {
  const { scenario } = parseScenario(rawScenario(overrides));
  const running = await serve(scenario, { port: 0, ...serveOptions });
  const base = `http://127.0.0.1:${running.port}`;
  return {
    base,
    engine: running.engine,
    close: () => running.close(),
    get: (path, headers = {}) => fetch(base + path, { headers }),
    post: (path, body, headers = {}) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

/** Parse an SSE body into { payloads, done } — JSON events + [DONE] flag. */
export function parseSse(text) {
  const payloads = [];
  let done = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice("data: ".length);
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    payloads.push(JSON.parse(data));
  }
  return { payloads, done };
}

/** Concatenate the content deltas of an SSE payload list, per choice 0. */
export function joinContent(payloads) {
  let text = "";
  for (const payload of payloads) {
    const choice = (payload.choices ?? [])[0];
    if (choice?.delta?.content !== undefined && choice.delta.content !== null) {
      text += choice.delta.content;
    }
  }
  return text;
}
