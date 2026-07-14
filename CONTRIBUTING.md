# Contributing to stublm

Issues, discussions and pull requests are all welcome — this project aims to
stay small, zero-dependency at runtime, and deterministic to the byte.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/stublm.git
cd stublm
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 89 node:test tests
bash scripts/smoke.sh  # end-to-end CLI + HTTP check against examples/
```

`scripts/smoke.sh` exercises the real CLI (init, validate, inspect, reply,
a full HTTP serve session with SSE, scripted 429s, Bearer auth, --record,
exit codes, determinism) against the two bundled example scenarios and must
print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable modules
   (the matcher, template engine, timing scheduler and engine take data, not
   sockets — only server.ts and the CLI touch IO).
5. Changes to the scenario format need a row in `docs/scenario-format.md`,
   the README tables, and a loader test pinning the exact JSON-path error.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined.
- No network beyond loopback, ever — stublm binds 127.0.0.1 only and never
  makes an outbound request. No telemetry.
- Determinism is the product: the same scenario and the same request
  sequence must produce byte-identical output. No `Math.random`, no
  wall-clock reads outside the explicit `clock: "real"` opt-in — the seeded
  RNG and the per-session call counter are the only permitted sources.
- Tests must never sleep. Timing behavior is asserted on computed delay
  plans (`schedule()`), and HTTP tests use the `instant` profile.
- Scenario mistakes fail at load time with a JSON path, not at call time
  with a vague message; new matcher/template features must be validated by
  the loader.
- Exit codes (0 / 1 / 2), response headers (`x-stublm-rule`,
  `x-request-id`) and emitted error codes are stable API; do not repurpose
  them.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `stublm --version` output, the scenario file (or a minimal
fragment), the exact command line or HTTP request, and — for serve bugs —
the `--record` JSONL trail. A failing `stublm reply` one-liner is the
perfect repro.

## Security

Do not open public issues for security problems; use GitHub private
vulnerability reporting on this repository instead.
