# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-13

### Added

- `stublm serve`: a deterministic OpenAI-compatible HTTP server on
  127.0.0.1, generated entirely from one JSON scenario file —
  `/v1/chat/completions` (JSON and SSE), `/v1/models`, `/v1/embeddings`,
  `/healthz`, Bearer auth, CORS, and proper OpenAI error bodies throughout.
- Scenario-driven response rules: first-match selection on `model`
  (exact or trailing-`*` glob), `lastUser`/`system` text matchers
  (`equals`/`contains`/`regex`), `hasTool` and `stream` clauses, with
  `times` serve budgets for scripted fail-then-recover sequences.
- Scripted replies: text with strict `{{message}}`/`{{model}}`/`{{call}}`/
  `{{seed}}`/`{{server.name}}` templating (typos fail at load time),
  tool calls streamed as header + argument-fragment deltas, verbatim
  string arguments for malformed-JSON client testing, and scripted HTTP
  errors with status, code and `Retry-After`.
- Chunk-timing profiles for realistic SSE pacing: built-in `instant`
  (synchronous — the CI default), `steady`, `typewriter` and `bursty`,
  plus user-defined profiles (TTFT, inter-chunk delay, seeded jitter,
  burst shapes) and a per-request `x-stublm-profile` override header.
- Determinism end to end: replies, `chatcmpl-…`/`req_…`/`call_…` ids,
  embedding vectors and stream jitter all derive from the request `seed`
  (or a content hash) plus a per-session call counter; `clock: "fixed"`
  freezes `created` so runs are byte-identical.
- Seeded fallbacks for unmatched requests: `generate` (deterministic
  filler prose), `echo`, or strict `reject` (404 with
  `stublm_no_rule_matched`).
- Strict scenario loader: unknown keys, bad matchers, uncompilable
  regexes, template typos and unknown profile references are load-time
  errors with exact JSON paths; shadowing rules, dead model matchers and
  empty reject scenarios produce warnings.
- `/v1/embeddings` with seeded unit-length vectors (equal inputs embed
  identically), request-level `dimensions` override, and `usage`
  accounting consistent between streaming and non-streaming paths.
- A `--record` JSONL audit trail with per-session `seq` numbers, rule
  labels and token counts, plus `x-stublm-rule`/`x-request-id` response
  headers for asserting which rule served each request.
- CLI: `init` (starter scenario), `validate` (0/1/2 exit codes),
  `inspect` (table or JSON), `reply` (in-process calls with `--stream`,
  `--show-timing`, `--seed`, `--repeat`), and `serve` (`--port 0` for
  ephemeral, `--record`, `--quiet`).
- Public programmatic API (`loadScenarioFile`, `parseScenario`,
  `StubEngine`, `serve`, `schedule`, matcher/template/tokenizer building
  blocks) with type declarations.
- Two bundled example scenarios (support bot with a transient 429 and a
  slow-net profile; tool bot with auth, parallel and malformed tool
  calls), a scenario-format reference in `docs/scenario-format.md`, and
  trilingual READMEs (en/zh/ja).
- Test suite: 89 node:test tests (pure rng/tokenizer/template/matcher/
  timing/loader units, in-process engine sessions, loopback HTTP + SSE,
  real CLI child-process runs) and an end-to-end `scripts/smoke.sh`
  against the bundled examples.

[0.1.0]: https://github.com/JaydenCJ/stublm/releases/tag/v0.1.0
