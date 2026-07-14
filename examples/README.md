# Examples

Two scenario files that between them exercise every feature of the scenario
format. The test suite and `scripts/smoke.sh` both run against these files,
so they are guaranteed to stay working.

## Try it

```bash
# from the repository root, after `npm install && npm run build`
node dist/cli.js validate --scenario examples/support.stub.json
node dist/cli.js inspect  --scenario examples/support.stub.json
node dist/cli.js reply    --scenario examples/support.stub.json --message "Can I get a refund?"
node dist/cli.js reply    --scenario examples/support.stub.json --message "this is flaky" --repeat 2
node dist/cli.js serve    --scenario examples/support.stub.json --port 8437
```

## What each file demonstrates

| File | Demonstrates |
|---|---|
| `support.stub.json` | `contains`/`regex` matchers, `{{message}}`/`{{call}}` templating, a `times: 1` transient 429 with `Retry-After` for retry-path testing, a custom `slow-net` timing profile bound to streaming requests, and the seeded `generate` fallback |
| `toolbot.stub.json` | Bearer-key auth (`server.apiKey`), `hasTool` matching, parallel tool calls, deliberately malformed tool-call arguments (a string passed verbatim), and the `echo` fallback |

## Pointing a real client at it

Start the stub, then aim any OpenAI-compatible SDK at its base URL:

```bash
node dist/cli.js serve --scenario examples/support.stub.json --port 8437
```

```python
# any OpenAI-compatible client works; the key is whatever the scenario expects
client = OpenAI(base_url="http://127.0.0.1:8437/v1", api_key="unused")
reply = client.chat.completions.create(
    model="stub-large",
    messages=[{"role": "user", "content": "Can I get a refund?"}],
)
```

The client sees a complete chat-completions server — models list, SSE
streaming, usage accounting, scripted failures — and every byte it gets is
declared in the scenario file.
