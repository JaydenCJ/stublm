#!/usr/bin/env bash
# Smoke test for stublm: exercises the real CLI and the loopback HTTP server
# end to end against the bundled example scenarios. No network beyond
# 127.0.0.1, idempotent, runs from a clean checkout (after `npm install`).
# Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents every subcommand.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in init validate inspect reply serve; do
  echo "$HELP" | grep -q "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. init writes a starter scenario that validates cleanly and refuses overwrite.
(cd "$WORKDIR" && $CLI init >/dev/null) || fail "init failed"
[ -f "$WORKDIR/stublm.stub.json" ] || fail "init wrote nothing"
$CLI validate --scenario "$WORKDIR/stublm.stub.json" | grep -q "OK: starter-stub" || fail "starter scenario invalid"
set +e
(cd "$WORKDIR" && $CLI init >/dev/null 2>&1); [ $? -eq 2 ] || { set -e; fail "init overwrite should exit 2"; }
set -e
echo "[smoke] init ok (starter validates, overwrite refused)"

# 4. Exit codes: unknown command 2, unreadable file 2, invalid scenario 1 with a JSON path.
set +e
$CLI frobnicate >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown command should exit 2"; }
$CLI validate --scenario "$WORKDIR/nope.json" >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing scenario should exit 2"; }
set -e
printf '{"server":{"name":"x"},"rules":[{"reply":"{{mesage}}"}]}' > "$WORKDIR/bad.json"
set +e
BAD_OUT="$($CLI validate --scenario "$WORKDIR/bad.json" 2>&1)"; BAD_CODE=$?
set -e
[ "$BAD_CODE" -eq 1 ] || fail "invalid scenario should exit 1, got $BAD_CODE"
echo "$BAD_OUT" | grep -q '\$\.rules\[0\]' || fail "validate error missing JSON path: $BAD_OUT"
echo "[smoke] exit codes ok (2 usage/io, 1 invalid)"

# 5. validate + inspect on the bundled examples.
$CLI validate --scenario examples/support.stub.json | grep -q "OK: support-stub" || fail "support example invalid"
$CLI validate --scenario examples/toolbot.stub.json | grep -q "OK: toolbot-stub" || fail "toolbot example invalid"
INSPECT_OUT="$($CLI inspect --scenario examples/support.stub.json)"
echo "$INSPECT_OUT" | grep -q "refund-policy" || fail "inspect missing refund-policy"
echo "$INSPECT_OUT" | grep -q "error 429" || fail "inspect missing the scripted 429"
$CLI inspect --scenario examples/support.stub.json --format json | node -e \
  "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const j=JSON.parse(s);if(j.rules.length!==4)throw new Error('want 4 rules')})" \
  || fail "inspect --format json broken"
echo "[smoke] validate/inspect ok (both examples)"

# 6. reply: matched rule, a fail-then-recover sequence, and seeded determinism.
$CLI reply --scenario examples/support.stub.json --message "Can I get a refund?" \
  | grep -q "Refunds are processed within 5 business days" || fail "refund rule did not match"
set +e
SEQ_OUT="$($CLI reply --scenario examples/support.stub.json --message "this is flaky" --repeat 2)"; SEQ_CODE=$?
set -e
[ "$SEQ_CODE" -eq 1 ] || fail "sequence with an error should exit 1, got $SEQ_CODE"
echo "$SEQ_OUT" | head -1 | grep -q '"status":429' || fail "first flaky call should 429"
echo "$SEQ_OUT" | tail -1 | grep -qv '429' || fail "second flaky call should recover"
$CLI reply --scenario examples/support.stub.json --message "seeded" --seed 42 > "$WORKDIR/run1.txt"
$CLI reply --scenario examples/support.stub.json --message "seeded" --seed 42 > "$WORKDIR/run2.txt"
cmp -s "$WORKDIR/run1.txt" "$WORKDIR/run2.txt" || fail "seeded replies are not deterministic"
echo "[smoke] reply ok (matching, sequence, determinism)"

# 7. reply --stream: SSE frames reassemble and the timing plan is annotated.
STREAM_OUT="$($CLI reply --scenario examples/support.stub.json --message "stream please" \
  --model stub-mini --stream --show-timing --seed 42)"
echo "$STREAM_OUT" | head -1 | grep -q '^: +800ms' || fail "slow-net TTFT annotation missing"
echo "$STREAM_OUT" | grep -q 'data: \[DONE\]' || fail "stream missing [DONE]"
echo "$STREAM_OUT" | grep -q '"finish_reason":"stop"' || fail "stream missing finish chunk"
echo "[smoke] stream ok (slow-net plan annotated, [DONE] terminated)"

# 8. serve: a real HTTP session on 127.0.0.1 — health, models, chat, SSE,
#    scripted 429, auth, and the --record trail.
$CLI serve --scenario examples/support.stub.json --port 0 --quiet --record "$WORKDIR/trail.jsonl" \
  > "$WORKDIR/serve.log" 2>&1 &
SERVER_PID=$!
PORT=""
for _ in $(seq 1 50); do
  PORT="$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$WORKDIR/serve.log" | head -1 | grep -o '[0-9]*$' || true)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || fail "serve did not report its port"
BASE="http://127.0.0.1:$PORT"
curl -sf "$BASE/healthz" | grep -q '"server":"support-stub"' || fail "healthz wrong"
curl -sf "$BASE/v1/models" | grep -q '"stub-large"' || fail "/v1/models missing stub-large"
curl -sf "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"stub-large","messages":[{"role":"user","content":"Can I get a refund?"}]}' \
  | grep -q "Refunds are processed" || fail "HTTP chat did not hit the refund rule"
curl -sf "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -H 'x-stublm-profile: instant' \
  -d '{"model":"stub-mini","stream":true,"messages":[{"role":"user","content":"stream please"}]}' \
  | grep -q '^data: \[DONE\]' || fail "HTTP SSE stream missing [DONE]"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"stub-large","messages":[{"role":"user","content":"this is flaky"}]}')"
[ "$STATUS" = "429" ] || fail "scripted 429 not served over HTTP (got $STATUS)"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
grep -q '"endpoint":"models"' "$WORKDIR/trail.jsonl" || fail "record missing models"
grep -q '"rule":"refund-policy"' "$WORKDIR/trail.jsonl" || fail "record missing refund rule"
grep -q '"status":429' "$WORKDIR/trail.jsonl" || fail "record missing the 429"
# healthz is intentionally not recorded: models + chat + stream + 429 = 4.
[ "$(wc -l < "$WORKDIR/trail.jsonl")" -eq 4 ] || fail "expected 4 record lines"
echo "[smoke] serve ok (HTTP chat, SSE, scripted 429, JSONL trail)"

# 9. Bearer auth on the toolbot example (apiKey scenarios).
$CLI serve --scenario examples/toolbot.stub.json --port 0 --quiet > "$WORKDIR/serve2.log" 2>&1 &
SERVER_PID=$!
PORT2=""
for _ in $(seq 1 50); do
  PORT2="$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$WORKDIR/serve2.log" | head -1 | grep -o '[0-9]*$' || true)"
  [ -n "$PORT2" ] && break
  sleep 0.1
done
[ -n "$PORT2" ] || fail "toolbot serve did not report its port"
BASE2="http://127.0.0.1:$PORT2"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE2/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"stub-tool","messages":[{"role":"user","content":"hi"}]}')"
[ "$STATUS" = "401" ] || fail "missing API key should 401 (got $STATUS)"
curl -sf "$BASE2/v1/chat/completions" \
  -H 'content-type: application/json' -H 'authorization: Bearer test-key-123' \
  -d '{"model":"stub-tool","messages":[{"role":"user","content":"compare the cities"}]}' \
  | grep -q '"tool_calls"' || fail "authorized tool-call request failed"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
echo "[smoke] auth ok (401 without key, tool calls with key)"

echo "SMOKE OK"
