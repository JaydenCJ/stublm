// The stublm CLI, run as a real child process against the built dist/.
// Exit codes (0 / 1 / 2) are stable API and pinned here, alongside the
// human-facing output of init/validate/inspect/reply.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EXAMPLES, rawScenario, runCli, tempDir, writeScenarioFile } from "./helpers.mjs";

const SUPPORT = join(EXAMPLES, "support.stub.json");
const TOOLBOT = join(EXAMPLES, "toolbot.stub.json");

test("--version prints the package version", () => {
  const { status, stdout } = runCli(["--version"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "0.1.0");
});

test("--help documents every subcommand; usage mistakes exit 2", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  for (const word of ["init", "validate", "inspect", "reply", "serve"]) {
    assert.ok(help.stdout.includes(word), `--help missing ${word}`);
  }
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(["frobnicate"]).status, 2);
  assert.equal(runCli(["validate", "--bogus-flag"]).status, 2);
});

test("init writes a valid starter scenario and refuses overwrite without --force", () => {
  const dir = tempDir("init");
  assert.equal(runCli(["init"], { cwd: dir }).status, 0);
  const path = join(dir, "stublm.stub.json");
  assert.ok(existsSync(path));
  const check = runCli(["validate", "--scenario", path]);
  assert.equal(check.status, 0);
  assert.match(check.stdout, /OK: starter-stub/);
  const second = runCli(["init"], { cwd: dir });
  assert.equal(second.status, 2);
  assert.match(second.stderr, /--force/);
  assert.equal(runCli(["init", "--force"], { cwd: dir }).status, 0);
  // The starter file demonstrates the documented features.
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(parsed.server.name, "starter-stub");
  assert.deepEqual(parsed.models, ["stub-large", "stub-mini"]);
  assert.equal(parsed.rules.length, 3);
  assert.ok(parsed.profiles["slow-net"]);
});

test("validate: unreadable file exits 2, invalid scenario exits 1 with paths", () => {
  const missing = runCli(["validate", "--scenario", "/definitely/missing.json"]);
  assert.equal(missing.status, 2);
  const dir = tempDir("validate");
  const path = writeScenarioFile(
    dir,
    rawScenario({ rules: [{ reply: "{{oops}}" }] }),
    "bad.stub.json"
  );
  const invalid = runCli(["validate", "--scenario", path]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /\$\.rules\[0\]/);
  assert.match(invalid.stderr, /unknown template path "oops"/);
});

test("validate prints loader warnings for suspicious scenarios", () => {
  const dir = tempDir("warn");
  const path = writeScenarioFile(
    dir,
    rawScenario({ rules: [{ reply: "always" }, { reply: "never" }] })
  );
  const result = runCli(["validate", "--scenario", path]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /warning: .*unreachable/);
});

test("validate accepts both bundled examples", () => {
  const support = runCli(["validate", "--scenario", SUPPORT]);
  assert.equal(support.status, 0);
  assert.match(support.stdout, /OK: support-stub/);
  const toolbot = runCli(["validate", "--scenario", TOOLBOT]);
  assert.equal(toolbot.status, 0);
  assert.match(toolbot.stdout, /OK: toolbot-stub/);
});

test("inspect renders the rule table for the support example", () => {
  const { status, stdout } = runCli(["inspect", "--scenario", SUPPORT]);
  assert.equal(status, 0);
  assert.match(stdout, /support-stub v1\.2\.3/);
  assert.match(stdout, /refund-policy/);
  assert.match(stdout, /error 429/);
  assert.match(stdout, /slow-net/);
});

test("inspect --format json is machine-readable; bad formats exit 2", () => {
  const { status, stdout } = runCli(["inspect", "--scenario", SUPPORT, "--format", "json"]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.server.name, "support-stub");
  assert.equal(parsed.rules.length, 4);
  assert.equal(parsed.rules[2].times, 1);
  assert.equal(runCli(["inspect", "--scenario", SUPPORT, "--format", "yaml"]).status, 2);
});

test("reply serves the matched rule's text", () => {
  const { status, stdout } = runCli([
    "reply",
    "--scenario",
    SUPPORT,
    "--message",
    "Can I get a refund?",
  ]);
  assert.equal(status, 0);
  assert.equal(
    stdout.trim(),
    "Refunds are processed within 5 business days. You asked: Can I get a refund?"
  );
  // --json emits the full chat.completion object instead.
  const asJson = runCli([
    "reply",
    "--scenario",
    SUPPORT,
    "--message",
    "Can I get a refund?",
    "--json",
  ]);
  assert.equal(asJson.status, 0);
  const body = JSON.parse(asJson.stdout);
  assert.equal(body.object, "chat.completion");
  assert.match(body.id, /^chatcmpl-/);
  assert.ok(body.usage.total_tokens > 0);
});

test("reply --seed is reproducible across separate processes", () => {
  const args = ["reply", "--scenario", SUPPORT, "--message", "unmatched question", "--seed", "42"];
  const a = runCli(args);
  const b = runCli(args);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
});

test("reply --repeat plays a fail-then-recover sequence and exits 1", () => {
  const { status, stdout } = runCli([
    "reply",
    "--scenario",
    SUPPORT,
    "--message",
    "this one is flaky",
    "--repeat",
    "2",
  ]);
  assert.equal(status, 1, "an errored reply in the sequence must exit 1");
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"status":429/);
  assert.doesNotMatch(lines[1], /429/);
});

test("reply --stream emits SSE frames that reassemble and end in [DONE]", () => {
  const { status, stdout } = runCli([
    "reply",
    "--scenario",
    SUPPORT,
    "--message",
    "Can I get a refund?",
    "--stream",
  ]);
  assert.equal(status, 0);
  assert.ok(stdout.startsWith("data: "));
  assert.ok(stdout.trimEnd().endsWith("data: [DONE]"));
  const contents = [...stdout.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]);
  assert.equal(
    contents.join(""),
    "Refunds are processed within 5 business days. You asked: Can I get a refund?"
  );
  // --show-timing prepends an SSE comment per frame with the planned delay.
  const timed = runCli([
    "reply",
    "--scenario",
    SUPPORT,
    "--message",
    "stream please",
    "--model",
    "stub-mini",
    "--stream",
    "--show-timing",
    "--seed",
    "42",
  ]);
  assert.equal(timed.status, 0);
  // The watch-it-render rule uses the slow-net profile: TTFT 800ms.
  assert.match(timed.stdout, /^: \+800ms\n/);
  assert.match(timed.stdout, /: \+[456]\dms\n/);
});


test("reply prints tool calls for tool-call rules", () => {
  const { status, stdout } = runCli([
    "reply",
    "--scenario",
    TOOLBOT,
    "--message",
    "compare the cities",
  ]);
  assert.equal(status, 0);
  const calls = JSON.parse(stdout);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "Osaka", unit: "c" });
});

test("reply flag validation: missing --message/--scenario and bad numbers exit 2", () => {
  assert.equal(runCli(["reply", "--scenario", SUPPORT]).status, 2);
  assert.equal(runCli(["reply", "--message", "x"]).status, 2);
  assert.equal(
    runCli(["reply", "--scenario", SUPPORT, "--message", "x", "--repeat", "zero"]).status,
    2
  );
  assert.equal(
    runCli(["reply", "--scenario", SUPPORT, "--message", "x", "--seed", "-5"]).status,
    2
  );
  for (const command of ["validate", "inspect"]) {
    const result = runCli([command]);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /--scenario/);
  }
});
