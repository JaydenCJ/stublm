#!/usr/bin/env node
/**
 * The `stublm` command line: init / validate / inspect / reply / serve.
 * Exit codes are stable API: 0 success, 1 invalid scenario or an errored
 * reply, 2 usage mistakes and unreadable files. Everything except `serve`
 * completes synchronously and never touches the network; `serve` binds
 * 127.0.0.1 only.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StubEngine } from "./engine.js";
import { ScenarioError, ScenarioFileError, loadScenarioFile } from "./scenario.js";
import type { LoadResult } from "./scenario.js";
import { serve } from "./server.js";
import { streamFrames } from "./sse.js";
import { STARTER_FILENAME, starterJson } from "./starter.js";
import type { ChatRequest, Rule, Scenario, TextMatch } from "./types.js";
import { VERSION } from "./version.js";

const USAGE = `stublm ${VERSION} — deterministic OpenAI-compatible stub server

Usage:
  stublm init [path] [--force]
  stublm validate --scenario <file>
  stublm inspect  --scenario <file> [--format table|json]
  stublm reply    --scenario <file> --message <text> [--model <id>] [--seed <n>]
                  [--system <text>] [--stream] [--show-timing] [--json] [--repeat <n>]
  stublm serve    --scenario <file> [--port <n>] [--record <file.jsonl>] [--quiet]

Exit codes: 0 success | 1 invalid scenario or errored reply | 2 usage / unreadable file
`;

const VALUE_FLAGS = new Set([
  "--scenario",
  "--format",
  "--message",
  "--model",
  "--seed",
  "--system",
  "--repeat",
  "--port",
  "--record",
]);
const BOOL_FLAGS = new Set([
  "--force",
  "--stream",
  "--show-timing",
  "--json",
  "--quiet",
  "--help",
  "--version",
]);

interface Args {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = { positionals: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      args.positionals.push(token);
      continue;
    }
    if (BOOL_FLAGS.has(token)) {
      args.flags.set(token, true);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined) {
        return `${token} requires a value`;
      }
      args.flags.set(token, value);
      i += 1;
      continue;
    }
    return `unknown flag ${token}`;
  }
  return args;
}

function str(args: Args, flag: string): string | undefined {
  const value = args.flags.get(flag);
  return typeof value === "string" ? value : undefined;
}

function intFlag(args: Args, flag: string, fallback: number): number | null {
  const raw = str(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Load a scenario; on failure print + set the exit code, return null. */
function loadOrReport(path: string | undefined): LoadResult | null {
  if (path === undefined) {
    console.error("missing required --scenario <file>");
    process.exitCode = 2;
    return null;
  }
  try {
    return loadScenarioFile(path);
  } catch (error) {
    if (error instanceof ScenarioFileError) {
      console.error(error.message);
      process.exitCode = 2;
    } else if (error instanceof ScenarioError) {
      console.error(`invalid scenario (${error.issues.length} issue(s)):`);
      for (const issue of error.issues) {
        console.error(`  ${issue}`);
      }
      process.exitCode = 1;
    } else {
      console.error(String(error));
      process.exitCode = 2;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit(args: Args): void {
  const target = resolve(
    args.positionals[0] !== undefined ? args.positionals[0] : join(process.cwd(), STARTER_FILENAME)
  );
  if (existsSync(target) && args.flags.get("--force") !== true) {
    console.error(`${target} already exists (use --force to overwrite)`);
    process.exitCode = 2;
    return;
  }
  writeFileSync(target, starterJson());
  console.log(`wrote ${target}`);
}

function cmdValidate(args: Args): void {
  const loaded = loadOrReport(str(args, "--scenario"));
  if (loaded === null) return;
  const { scenario, warnings } = loaded;
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
  console.log(
    `OK: ${scenario.server.name} — ${scenario.rules.length} rule(s), ` +
      `${scenario.models.length} model(s), ${Object.keys(scenario.profiles).length} custom profile(s), ` +
      `fallback "${scenario.fallback.mode}"`
  );
}

function matchSummary(match: TextMatch): string {
  const clip = (s: string): string => (s.length > 24 ? s.slice(0, 23) + "…" : s);
  if (match.equals !== undefined) return `= "${clip(match.equals)}"`;
  if (match.contains !== undefined) return `has "${clip(match.contains)}"`;
  if (match.regex !== undefined) return `/${clip(match.regex)}/`;
  return "any";
}

function whenSummary(rule: Rule): string {
  const when = rule.when;
  if (when === undefined || Object.keys(when).length === 0) return "always";
  const parts: string[] = [];
  if (when.model !== undefined) parts.push(`model=${when.model}`);
  if (when.lastUser !== undefined) parts.push(`lastUser ${matchSummary(when.lastUser)}`);
  if (when.system !== undefined) parts.push(`system ${matchSummary(when.system)}`);
  if (when.hasTool !== undefined) parts.push(`hasTool=${when.hasTool}`);
  if (when.stream !== undefined) parts.push(`stream=${String(when.stream)}`);
  return parts.join(", ");
}

function resultSummary(rule: Rule): string {
  if (rule.error !== undefined) return `error ${rule.error.status}`;
  const reply = rule.reply;
  if (reply === undefined) return "-";
  if (reply.toolCalls !== undefined) {
    return `tool_calls(${reply.toolCalls.map((tc) => tc.name).join(",")})`;
  }
  return "text";
}

function cmdInspect(args: Args): void {
  const loaded = loadOrReport(str(args, "--scenario"));
  if (loaded === null) return;
  const { scenario } = loaded;
  const format = str(args, "--format") ?? "table";
  if (format === "json") {
    console.log(
      JSON.stringify({
        server: { name: scenario.server.name, version: scenario.server.version },
        models: scenario.models,
        options: scenario.options,
        profiles: Object.keys(scenario.profiles),
        rules: scenario.rules.map((rule, index) => ({
          index,
          label: rule.label ?? null,
          when: whenSummary(rule),
          times: rule.times ?? null,
          result: resultSummary(rule),
          profile: rule.profile ?? null,
        })),
        fallback: scenario.fallback,
      })
    );
    return;
  }
  if (format !== "table") {
    console.error(`unknown --format "${format}" (use table or json)`);
    process.exitCode = 2;
    return;
  }
  console.log(
    `${scenario.server.name} v${scenario.server.version} — ${scenario.rules.length} rule(s), ` +
      `${scenario.models.length} model(s), default profile "${scenario.options.defaultProfile}"`
  );
  console.log(`models: ${scenario.models.length > 0 ? scenario.models.join(", ") : "(any)"}`);
  console.log("");
  const rows = scenario.rules.map((rule, index) => [
    String(index),
    rule.label ?? "-",
    whenSummary(rule),
    rule.times !== undefined ? String(rule.times) : "-",
    resultSummary(rule),
    rule.profile ?? "-",
  ]);
  const header = ["#", "LABEL", "WHEN", "TIMES", "RESULT", "PROFILE"];
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((row) => (row[col] as string).length))
  );
  // trimEnd: the last column must not leave invisible trailing padding.
  const renderRow = (row: string[]): string =>
    row.map((cell, col) => cell.padEnd(widths[col] as number)).join("  ").trimEnd();
  console.log(renderRow(header));
  for (const row of rows) {
    console.log(renderRow(row));
  }
  console.log("");
  console.log(
    `fallback: ${scenario.fallback.mode}` +
      (scenario.fallback.mode === "generate" ? ` (${scenario.fallback.sentences} sentence(s))` : "")
  );
}

function cmdReply(args: Args): void {
  const loaded = loadOrReport(str(args, "--scenario"));
  if (loaded === null) return;
  const { scenario } = loaded;
  const message = str(args, "--message");
  if (message === undefined) {
    console.error("missing required --message <text>");
    process.exitCode = 2;
    return;
  }
  const repeat = intFlag(args, "--repeat", 1);
  const seed = intFlag(args, "--seed", -1);
  if (repeat === null || repeat < 1 || seed === null) {
    console.error("--repeat must be a positive integer and --seed a non-negative integer");
    process.exitCode = 2;
    return;
  }
  const model = str(args, "--model") ?? scenario.models[0] ?? "stub-model";
  const system = str(args, "--system");
  const stream = args.flags.get("--stream") === true;

  const engine = new StubEngine(scenario);
  let anyError = false;
  for (let i = 0; i < repeat; i++) {
    const request: ChatRequest = {
      model,
      messages: [
        ...(system !== undefined ? [{ role: "system", content: system }] : []),
        { role: "user", content: message },
      ],
      ...(stream ? { stream: true } : {}),
      ...(seed >= 0 ? { seed } : {}),
    };
    const outcome = engine.chat(request);
    if (outcome.kind === "error") {
      anyError = true;
      console.log(JSON.stringify({ status: outcome.status, ...outcome.body }));
      continue;
    }
    if (stream) {
      const frames = streamFrames(outcome, {
        showTiming: args.flags.get("--show-timing") === true,
      });
      process.stdout.write(frames.join(""));
      continue;
    }
    if (args.flags.get("--json") === true) {
      console.log(JSON.stringify(outcome.response));
      continue;
    }
    const choices = outcome.response.choices as {
      message: { content: string | null; tool_calls?: unknown };
    }[];
    const first = choices[0];
    if (first !== undefined && first.message.tool_calls !== undefined) {
      console.log(JSON.stringify(first.message.tool_calls));
    } else {
      console.log(first?.message.content ?? "");
    }
  }
  if (anyError) {
    process.exitCode = 1;
  }
}

async function cmdServe(args: Args): Promise<void> {
  const loaded = loadOrReport(str(args, "--scenario"));
  if (loaded === null) return;
  const { scenario, warnings } = loaded;
  const port = intFlag(args, "--port", 8437);
  if (port === null || port > 65535) {
    console.error("--port must be an integer between 0 and 65535");
    process.exitCode = 2;
    return;
  }
  const quiet = args.flags.get("--quiet") === true;
  for (const warning of warnings) {
    console.error(`warning: ${warning}`);
  }
  const record = str(args, "--record");
  const running = await serve(scenario, {
    port,
    ...(record !== undefined ? { recordPath: record } : {}),
    ...(quiet ? {} : { log: (line: string) => console.error(`[stublm] ${line}`) }),
  });
  console.log(
    `[stublm] serving "${scenario.server.name}" v${scenario.server.version} ` +
      `on http://127.0.0.1:${running.port} — ${scenario.rules.length} rule(s), ` +
      `${scenario.models.length} model(s), default profile "${scenario.options.defaultProfile}"`
  );
  process.on("SIGINT", () => {
    void running.close().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void running.close().then(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(parsed);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (parsed.flags.get("--version") === true) {
    console.log(VERSION);
    return;
  }
  const command = parsed.positionals.shift();
  if (command === undefined || parsed.flags.get("--help") === true) {
    console.log(USAGE);
    if (command === undefined && parsed.flags.get("--help") !== true) {
      process.exitCode = 2;
    }
    return;
  }
  switch (command) {
    case "init":
      cmdInit(parsed);
      return;
    case "validate":
      cmdValidate(parsed);
      return;
    case "inspect":
      cmdInspect(parsed);
      return;
    case "reply":
      cmdReply(parsed);
      return;
    case "serve":
      await cmdServe(parsed);
      return;
    default:
      console.error(`unknown command "${command}"`);
      console.error(USAGE);
      process.exitCode = 2;
  }
}

void main();
