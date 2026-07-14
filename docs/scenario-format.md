# The stublm scenario format

One JSON file describes the entire stub server: identity, models, timing
profiles, response rules and the fallback. This page is the full reference
for `0.1.0`. Run `stublm validate --scenario <file>` after editing — every
mistake is reported with a JSON path into the file, at load time, never at
call time.

## Top level

| Key | Required | Default | Meaning |
|---|---|---|---|
| `server` | yes | — | `{ name, version?, apiKey? }`; `name` seeds the `system_fingerprint`, `apiKey` (if set) turns on Bearer auth |
| `models` | no | `[]` | model ids listed by `/v1/models`; with `strictModels`, anything else 404s |
| `options` | no | see below | behavior switches |
| `profiles` | no | `{}` | named chunk-timing profiles, merged over the built-ins |
| `rules` | no | `[]` | response rules, tried in order |
| `fallback` | no | `{ "mode": "generate", "sentences": 3 }` | what happens when no rule matches |

Unknown keys anywhere in the file are **errors**, not ignored — that is the
anti-typo net.

## `options`

| Key | Default | Effect |
|---|---|---|
| `defaultProfile` | `"instant"` | timing profile used when neither the rule nor the request names one |
| `clock` | `"fixed"` | `"fixed"` pins `created` to `1735689600` so runs are byte-identical; `"real"` uses the wall clock |
| `embeddingDims` | `32` | vector width for `/v1/embeddings` (a request's `dimensions` wins) |
| `strictModels` | `true` | 404 (`model_not_found`) for models outside `models` — catches typos in the client under test |
| `cors` | `true` | emit permissive CORS headers so browser UIs can call the stub directly |

## Rules

Rules are tried **in order**; the first whose `when` matches and whose
`times` budget is not exhausted is served. Each rule has **exactly one** of
`reply` / `error`.

| Key | Default | Effect |
|---|---|---|
| `label` | — | shown by `inspect` and returned in the `x-stublm-rule` response header |
| `when` | match all | conjunction of the clauses below; an absent clause matches everything |
| `times` | unlimited | serve at most N times, then fall through — scripts fail-then-recover sequences |
| `profile` | scenario default | timing profile for this rule's streamed responses |
| `reply` | — | a string (template shorthand) or `{ text?, toolCalls?, finishReason? }` |
| `error` | — | `{ status, message, type?, code?, param?, retryAfterSeconds? }` |

### `when` clauses

| Clause | Matches |
|---|---|
| `model` | exact model id, or a trailing-`*` glob (`"stub-*"`) |
| `lastUser` | text of the **last** `user` message, via exactly one of `equals` / `contains` / `regex` |
| `system` | concatenated text of all `system` messages, same matcher keys |
| `hasTool` | the request declares a function tool with this name |
| `stream` | `true` matches only SSE requests, `false` only plain ones |

Matching is case-sensitive and exact by design: a stub that fuzzy-matches
would hide client bugs.

### Reply templates

Reply text may use `{{message}}` (last user text), `{{model}}`, `{{call}}`
(1-based chat request count this session), `{{seed}}` (effective seed) and
`{{server.name}}`. Unknown placeholders are load-time errors.

### Tool calls

```json
"reply": {
  "toolCalls": [
    { "name": "get_weather", "arguments": { "city": "Osaka" } },
    { "name": "get_weather", "arguments": "{\"city\": \"Sapporo\", \"unit\":" }
  ]
}
```

Object `arguments` are JSON-serialized; a **string** is used verbatim — on
purpose, so you can script a model that emits malformed arguments and test
how your client copes. `finish_reason` defaults to `tool_calls`. In streams,
each call gets a header delta (id, name) followed by argument-fragment
deltas, exactly like the real API.

### Errors

`status` must be 400–599. `type` defaults per status class
(`rate_limit_error` for 429, `server_error` for 5xx, `invalid_request_error`
otherwise). `retryAfterSeconds` adds a `Retry-After` header so client
backoff paths can be exercised.

## Timing profiles

A profile shapes the SSE pacing of streamed responses. All values are
milliseconds; jitter is drawn from a **seeded** RNG, so a request with a
fixed `seed` gets the same delay plan every run.

| Key | Meaning |
|---|---|
| `ttftMs` | delay before the first chunk (time to first token) |
| `interChunkMs` | base delay between subsequent chunks |
| `jitterMs` | max seeded jitter added per chunk, uniform in `[0, jitterMs]` |
| `burst` | `{ size, pauseMs }`: chunks arrive in groups of `size` with a `pauseMs` gap between groups |

Built-ins: `instant` (all zero — the CI default, streams complete without
waiting), `steady` (300/24/8), `typewriter` (150/45/0) and `bursty`
(500/5/4 + bursts of 4 with 180 ms pauses). `instant` cannot be redefined —
it is the guaranteed zero-cost escape hatch. A request can override any
profile with the `x-stublm-profile` header.

## Fallback

| Mode | Behavior when no rule matches |
|---|---|
| `generate` | `sentences` of seeded, deterministic filler prose — same seed, same text |
| `echo` | repeat the last user message back (handy for pipeline plumbing tests) |
| `reject` | a 404 with code `stublm_no_rule_matched` — strict fixtures that must enumerate every case |

## Determinism contract

The effective seed is the request's `seed` if present, else a hash of the
model and messages. Everything derived — reply prose, ids
(`chatcmpl-…`, `req_…`, `call_…`), embedding vectors, jitter — flows from
that seed plus the per-session call counter. The same scenario and the same
request sequence produce byte-identical responses; `clock: "real"` is the
only opt-out.
