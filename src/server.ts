/**
 * The HTTP transport: a `node:http` server that binds 127.0.0.1 only and
 * exposes the engine as an OpenAI-compatible API — `/v1/chat/completions`
 * (JSON and SSE), `/v1/models`, `/v1/embeddings`, plus `/healthz` for
 * readiness polls. All behavior lives in the engine; this file only reads
 * bodies, checks the bearer key, paces SSE frames per the planned delays,
 * and appends the --record trail.
 */

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { StubEngine } from "./engine.js";
import { encodeDone, encodeEvent } from "./sse.js";
import type { CompletionOutcome, ErrorBody, Scenario } from "./types.js";
import { VERSION } from "./version.js";

export interface ServeOptions {
  /** 0 = pick a free port; the actual port is in `RunningServer.port`. */
  port: number;
  /** Append one JSON line per handled request to this file. */
  recordPath?: string;
  /** Called with human-readable log lines (suppressed by `serve --quiet`). */
  log?: (line: string) => void;
}

export interface RunningServer {
  server: Server;
  port: number;
  engine: StubEngine;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";

function corsHeaders(scenario: Scenario): Record<string, string> {
  if (!scenario.options.cors) return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-stublm-profile",
  };
}

function errorBody(
  message: string,
  type: string,
  code: string | null,
  param: string | null = null
): ErrorBody {
  return { error: { message, type, param, code } };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string>
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/** Write SSE frames, honoring each chunk's planned delay. Zero-delay plans
 * (the `instant` profile) complete synchronously — tests never sleep. A
 * client disconnect stops the pump instead of streaming into a dead socket
 * for the remainder of a slow profile's plan. */
function sendStream(
  res: ServerResponse,
  outcome: CompletionOutcome,
  extraHeaders: Record<string, string>
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...extraHeaders,
  });
  let i = 0;
  const emit = (): void => {
    res.write(encodeEvent(outcome.chunks[i] as NonNullable<(typeof outcome.chunks)[0]>));
    i += 1;
  };
  const pump = (): void => {
    while (i < outcome.chunks.length) {
      const delay = outcome.delays[i] ?? 0;
      if (delay > 0) {
        setTimeout(() => {
          if (res.destroyed) return;
          emit();
          pump();
        }, delay);
        return;
      }
      emit();
    }
    res.write(encodeDone());
    res.end();
  };
  pump();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolvePromise(body));
  });
}

function checkAuth(scenario: Scenario, req: IncomingMessage): ErrorBody | null {
  const expected = scenario.server.apiKey;
  if (expected === undefined) return null;
  const header = req.headers["authorization"];
  const value = typeof header === "string" ? header : "";
  if (value === "") {
    return errorBody(
      "You didn't provide an API key. Send it as: Authorization: Bearer <key>.",
      "invalid_request_error",
      "invalid_api_key"
    );
  }
  if (value !== `Bearer ${expected}`) {
    return errorBody(
      "Incorrect API key provided. The key must match the scenario's server.apiKey.",
      "invalid_request_error",
      "invalid_api_key"
    );
  }
  return null;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Build the request handler; exported for in-process tests. */
export function createStubServer(scenario: Scenario, options: ServeOptions): RunningServer {
  const engine = new StubEngine(scenario);
  const cors = corsHeaders(scenario);
  const log = options.log ?? (() => undefined);

  const recordTail = (): void => {
    if (options.recordPath === undefined) return;
    const entry = engine.log[engine.log.length - 1];
    if (entry !== undefined) {
      appendFileSync(options.recordPath, JSON.stringify(entry) + "\n");
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (method === "GET" && path === "/healthz") {
      sendJson(
        res,
        200,
        {
          status: "ok",
          server: scenario.server.name,
          version: scenario.server.version,
          stublm: VERSION,
        },
        cors
      );
      return;
    }

    const authFailure = checkAuth(scenario, req);
    if (authFailure !== null) {
      log(`401 ${method} ${path} (bad or missing API key)`);
      sendJson(res, 401, authFailure, cors);
      return;
    }

    if (method === "GET" && path === "/v1/models") {
      const body = engine.models();
      recordTail();
      log(`200 GET /v1/models (${scenario.models.length} model(s))`);
      sendJson(res, 200, body, cors);
      return;
    }

    if (method === "POST" && (path === "/v1/chat/completions" || path === "/v1/embeddings")) {
      void readBody(req).then((raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw === "" ? "null" : raw);
        } catch {
          log(`400 POST ${path} (body is not valid JSON)`);
          sendJson(
            res,
            400,
            errorBody("request body is not valid JSON", "invalid_request_error", null, "body"),
            cors
          );
          return;
        }

        if (path === "/v1/embeddings") {
          const outcome = engine.embeddings(parsed);
          recordTail();
          if (outcome.kind === "error") {
            log(`${outcome.status} POST /v1/embeddings (${outcome.body.error.message})`);
            sendJson(res, outcome.status, outcome.body, { ...cors, ...outcome.headers });
            return;
          }
          log(`200 POST /v1/embeddings`);
          sendJson(res, 200, outcome.response, { ...cors, "x-request-id": outcome.requestId });
          return;
        }

        const outcome = engine.chat(parsed, {
          ...(headerValue(req, "x-stublm-profile") !== undefined
            ? { profileOverride: headerValue(req, "x-stublm-profile") as string }
            : {}),
        });
        recordTail();
        if (outcome.kind === "error") {
          log(`${outcome.status} POST /v1/chat/completions [${outcome.ruleRef}]`);
          sendJson(res, outcome.status, outcome.body, { ...cors, ...outcome.headers });
          return;
        }
        const common = {
          ...cors,
          "x-request-id": outcome.requestId,
          "x-stublm-rule": outcome.ruleRef,
        };
        if (outcome.stream) {
          log(
            `200 POST /v1/chat/completions [${outcome.ruleRef}] streaming ${outcome.chunks.length} chunk(s), profile "${outcome.profileName}"`
          );
          sendStream(res, outcome, common);
          return;
        }
        log(`200 POST /v1/chat/completions [${outcome.ruleRef}]`);
        sendJson(res, 200, outcome.response, common);
      });
      return;
    }

    engine.noteUnmatched(method, path);
    recordTail();
    log(`404 ${method} ${path}`);
    sendJson(
      res,
      404,
      errorBody(`Unknown request URL: ${method} ${path}`, "invalid_request_error", null),
      cors
    );
  };

  const server = createServer(handler);
  return {
    server,
    port: 0,
    engine,
    close(): Promise<void> {
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/** Bind to 127.0.0.1 and resolve once listening (port 0 → ephemeral). */
export function serve(scenario: Scenario, options: ServeOptions): Promise<RunningServer> {
  const running = createStubServer(scenario, options);
  return new Promise((resolvePromise) => {
    running.server.listen(options.port, HOST, () => {
      const address = running.server.address();
      running.port =
        typeof address === "object" && address !== null ? address.port : options.port;
      resolvePromise(running);
    });
  });
}
