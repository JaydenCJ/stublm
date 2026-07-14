// The scenario loader. The promise under test: every scenario mistake is a
// load-time error with an exact JSON path, and suspicious-but-legal shapes
// produce warnings instead. Error-message paths are pinned deliberately —
// they are part of the CLI's contract with humans.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ScenarioError,
  ScenarioFileError,
  loadScenarioFile,
  parseScenario,
} from "../dist/index.js";
import { rawScenario, tempDir, writeScenarioFile } from "./helpers.mjs";

/** Parse and return the collected issue strings (asserting it throws). */
function issuesOf(raw) {
  try {
    parseScenario(raw);
  } catch (error) {
    assert.ok(error instanceof ScenarioError, `expected ScenarioError, got ${error}`);
    return error.issues;
  }
  assert.fail("expected parseScenario to throw");
}

test("a minimal scenario parses with defaults applied", () => {
  const { scenario, warnings } = parseScenario(rawScenario());
  assert.equal(scenario.server.name, "test-stub");
  assert.equal(scenario.options.defaultProfile, "instant");
  assert.equal(scenario.options.clock, "fixed");
  assert.equal(scenario.options.strictModels, true);
  assert.equal(scenario.fallback.mode, "generate");
  assert.deepEqual(scenario.rules, []);
  assert.deepEqual(warnings, []);
});

test("structural errors: non-object roots, unknown keys, duplicate models", () => {
  for (const bad of [null, [], "x", 42]) {
    assert.match(issuesOf(bad)[0], /^\$: expected object/);
  }
  assert.ok(
    issuesOf(rawScenario({ extraneous: true })).some((i) =>
      i.startsWith("$.extraneous: unknown key")
    )
  );
  assert.ok(
    issuesOf(rawScenario({ models: ["a", "b", "a"] })).some((i) =>
      i.startsWith('$.models[2]: duplicate model id "a"')
    )
  );
});

test("server.name is required and must be a non-empty string", () => {
  assert.ok(issuesOf({}).some((i) => i.startsWith("$.server:")));
  assert.ok(
    issuesOf({ server: { version: "1" } }).some((i) => i.startsWith("$.server.name: required"))
  );
  assert.ok(
    issuesOf({ server: { name: "" } }).some((i) => i.includes("$.server.name: must not be empty"))
  );
});

test("cardinality: exactly one of reply/error, exactly one matcher key", () => {
  const neither = issuesOf(rawScenario({ rules: [{ label: "x" }] }));
  assert.ok(neither.some((i) => i.includes("$.rules[0]: exactly one of reply/error")));
  const both = issuesOf(
    rawScenario({ rules: [{ reply: "hi", error: { status: 500, message: "boom" } }] })
  );
  assert.ok(both.some((i) => i.includes("$.rules[0]: exactly one of reply/error")));
  const twoKeys = issuesOf(
    rawScenario({ rules: [{ when: { lastUser: { equals: "a", contains: "b" } }, reply: "x" }] })
  );
  assert.ok(
    twoKeys.some((i) => i.includes("$.rules[0].when.lastUser: exactly one of equals/contains/regex"))
  );
});

test("uncompilable regexes and template typos fail at load time with paths", () => {
  const badRegex = issuesOf(
    rawScenario({ rules: [{ when: { lastUser: { regex: "([" } }, reply: "x" }] })
  );
  assert.ok(
    badRegex.some((i) => i.startsWith("$.rules[0].when.lastUser.regex: invalid regular expression"))
  );
  const badTemplate = issuesOf(rawScenario({ rules: [{ reply: "hello {{mesage}}" }] }));
  assert.ok(badTemplate.some((i) => i.includes('unknown template path "mesage"')));
});

test("unknown profile references and instant redefinition are load errors", () => {
  const onRule = issuesOf(rawScenario({ rules: [{ profile: "warp-speed", reply: "x" }] }));
  assert.ok(onRule.some((i) => i.includes('$.rules[0].profile: unknown profile "warp-speed"')));
  const onDefault = issuesOf(rawScenario({ options: { defaultProfile: "warp-speed" } }));
  assert.ok(onDefault.some((i) => i.startsWith("$.options.defaultProfile: unknown profile")));
  const redefined = issuesOf(
    rawScenario({ profiles: { instant: { ttftMs: 100, interChunkMs: 5, jitterMs: 0 } } })
  );
  assert.ok(redefined.some((i) => i.includes('"instant" profile cannot be redefined')));
});

test("error specs and burst profiles validate ranges and required fields", () => {
  const errorIssues = issuesOf(rawScenario({ rules: [{ error: { status: 200 } }] }));
  assert.ok(
    errorIssues.some((i) => i.includes("$.rules[0].error.status: must be between 400 and 599"))
  );
  assert.ok(errorIssues.some((i) => i.includes("$.rules[0].error.message: required")));
  const burstIssues = issuesOf(
    rawScenario({ profiles: { p: { ttftMs: 0, interChunkMs: 0, jitterMs: 0, burst: {} } } })
  );
  assert.ok(burstIssues.some((i) => i.includes("$.profiles.p.burst.size: required")));
  assert.ok(burstIssues.some((i) => i.includes("$.profiles.p.burst.pauseMs: required")));
});

test("multiple independent mistakes are all reported at once", () => {
  const issues = issuesOf(
    rawScenario({
      models: [""],
      rules: [{ when: { model: "" }, reply: "{{typo}}" }],
      fallback: { mode: "explode" },
    })
  );
  assert.ok(issues.length >= 4, `want >= 4 issues, got:\n${issues.join("\n")}`);
});

test("warnings flag shadowing rules, dead model matches and reject-with-no-rules", () => {
  const shadow = parseScenario(
    rawScenario({ rules: [{ reply: "always me" }, { reply: "never reached" }] })
  );
  assert.ok(shadow.warnings.some((w) => w.includes("later rules are unreachable")));
  const dead = parseScenario(
    rawScenario({ models: ["stub-a"], rules: [{ when: { model: "stub-b" }, reply: "x" }] })
  );
  assert.ok(dead.warnings.some((w) => w.includes("this rule never fires")));
  const reject = parseScenario(rawScenario({ fallback: { mode: "reject" } }));
  assert.ok(reject.warnings.some((w) => w.includes("every chat request will 404")));
});

test("loadScenarioFile: missing file and bad JSON raise ScenarioFileError", () => {
  const dir = tempDir("loader");
  assert.throws(() => loadScenarioFile(join(dir, "missing.json")), ScenarioFileError);
  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, "{ not json");
  assert.throws(() => loadScenarioFile(badPath), /not valid JSON/);
});

test("loadScenarioFile round-trips a file written to disk", () => {
  const dir = tempDir("roundtrip");
  const path = writeScenarioFile(dir, rawScenario({ models: ["stub-x"] }));
  const { scenario } = loadScenarioFile(path);
  assert.deepEqual(scenario.models, ["stub-x"]);
});
