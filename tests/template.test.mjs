// The {{…}} template engine. Its contract: typos die at load time (via
// firstBadPath), and rendering is a pure string substitution.
import assert from "node:assert/strict";
import { test } from "node:test";
import { firstBadPath, renderTemplate, templatePaths } from "../dist/index.js";

const SCOPE = {
  message: "what is the weather?",
  model: "stub-large",
  call: 3,
  seed: 42,
  server: { name: "test-stub" },
};

test("renderTemplate substitutes every known root", () => {
  assert.equal(
    renderTemplate("{{server.name}} run {{call}} (seed {{seed}}) on {{model}}: {{message}}", SCOPE),
    "test-stub run 3 (seed 42) on stub-large: what is the weather?"
  );
});

test("plain text, brace whitespace and repeated placeholders behave", () => {
  assert.equal(renderTemplate("no placeholders here", SCOPE), "no placeholders here");
  assert.equal(renderTemplate("{{ model }}", SCOPE), "stub-large");
  assert.equal(renderTemplate("{{call}}-{{call}}", SCOPE), "3-3");
  // Single braces and dangling braces are not placeholders.
  assert.equal(renderTemplate("{model} {{model} }}", SCOPE), "{model} {{model} }}");
});

test("renderTemplate throws TemplateError on unknown paths", () => {
  assert.throws(() => renderTemplate("{{nope}}", SCOPE), /unknown template path "nope"/);
});

test("templatePaths lists placeholders in order, with duplicates", () => {
  assert.deepEqual(templatePaths("{{message}} {{call}} {{message}}"), [
    "message",
    "call",
    "message",
  ]);
});

test("firstBadPath finds the first unknown root, or null", () => {
  assert.equal(firstBadPath("{{message}} then {{bogus}} then {{worse}}"), "bogus");
  assert.equal(firstBadPath("{{message}} {{server.name}}"), null);
  assert.equal(firstBadPath("plain"), null);
});
