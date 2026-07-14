/**
 * The scenario loader: parses and strictly validates a `*.stub.json` file
 * into a `Scenario`. Philosophy: every mistake fails at load time with an
 * exact JSON path — unknown keys, bad matchers, uncompilable regexes,
 * template typos — never at call time with a vague message. The loader also
 * emits non-fatal warnings for suspicious-but-legal scenarios (dead rules,
 * models that can never match).
 */

import { readFileSync } from "node:fs";
import { firstBadPath } from "./template.js";
import { BUILTIN_PROFILES, resolveProfile } from "./timing.js";
import type {
  ErrorSpec,
  FallbackMode,
  ReplySpec,
  Rule,
  RuleWhen,
  Scenario,
  TextMatch,
  TimingProfile,
  ToolCallSpec,
} from "./types.js";

export class ScenarioError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("\n"));
    this.issues = issues;
  }
}

/** Raised for unreadable / non-JSON files (CLI exit 2, vs 1 for invalid). */
export class ScenarioFileError extends Error {}

export interface LoadResult {
  scenario: Scenario;
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Ctx {
  readonly issues: string[] = [];
  readonly warnings: string[] = [];

  err(path: string, message: string): void {
    this.issues.push(`${path}: ${message}`);
  }

  warn(path: string, message: string): void {
    this.warnings.push(`${path}: ${message}`);
  }

  /** Reject keys outside `allowed`, with the offending path. */
  keys(path: string, obj: Record<string, unknown>, allowed: string[]): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        this.err(`${path}.${key}`, `unknown key (allowed: ${allowed.join(", ")})`);
      }
    }
  }

  str(path: string, value: unknown, opts: { nonEmpty?: boolean } = {}): string {
    if (typeof value !== "string") {
      this.err(path, `expected string, got ${typeName(value)}`);
      return "";
    }
    if (opts.nonEmpty === true && value.length === 0) {
      this.err(path, "must not be empty");
    }
    return value;
  }

  num(path: string, value: unknown, min: number, max: number): number {
    if (typeof value !== "number" || Number.isNaN(value)) {
      this.err(path, `expected number, got ${typeName(value)}`);
      return min;
    }
    if (value < min || value > max) {
      this.err(path, `must be between ${min} and ${max}`);
    }
    return value;
  }

  int(path: string, value: unknown, min: number, max: number): number {
    const n = this.num(path, value, min, max);
    if (typeof value === "number" && !Number.isInteger(value)) {
      this.err(path, "must be an integer");
    }
    return Math.trunc(n);
  }

  bool(path: string, value: unknown): boolean {
    if (typeof value !== "boolean") {
      this.err(path, `expected boolean, got ${typeName(value)}`);
      return false;
    }
    return value;
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

function parseTextMatch(ctx: Ctx, path: string, raw: unknown): TextMatch {
  if (!isPlainObject(raw)) {
    ctx.err(path, `expected object, got ${typeName(raw)}`);
    return {};
  }
  ctx.keys(path, raw, ["equals", "contains", "regex"]);
  const present = ["equals", "contains", "regex"].filter((k) => k in raw);
  if (present.length !== 1) {
    ctx.err(path, `exactly one of equals/contains/regex required, got ${present.length}`);
  }
  const match: TextMatch = {};
  if ("equals" in raw) match.equals = ctx.str(`${path}.equals`, raw.equals);
  if ("contains" in raw) match.contains = ctx.str(`${path}.contains`, raw.contains);
  if ("regex" in raw) {
    match.regex = ctx.str(`${path}.regex`, raw.regex);
    if (typeof raw.regex === "string") {
      try {
        new RegExp(raw.regex);
      } catch (error) {
        ctx.err(`${path}.regex`, `invalid regular expression: ${(error as Error).message}`);
      }
    }
  }
  return match;
}

function parseWhen(ctx: Ctx, path: string, raw: unknown): RuleWhen {
  if (!isPlainObject(raw)) {
    ctx.err(path, `expected object, got ${typeName(raw)}`);
    return {};
  }
  ctx.keys(path, raw, ["model", "lastUser", "system", "hasTool", "stream"]);
  const when: RuleWhen = {};
  if ("model" in raw) when.model = ctx.str(`${path}.model`, raw.model, { nonEmpty: true });
  if ("lastUser" in raw) when.lastUser = parseTextMatch(ctx, `${path}.lastUser`, raw.lastUser);
  if ("system" in raw) when.system = parseTextMatch(ctx, `${path}.system`, raw.system);
  if ("hasTool" in raw) when.hasTool = ctx.str(`${path}.hasTool`, raw.hasTool, { nonEmpty: true });
  if ("stream" in raw) when.stream = ctx.bool(`${path}.stream`, raw.stream);
  return when;
}

function parseToolCall(ctx: Ctx, path: string, raw: unknown): ToolCallSpec {
  if (!isPlainObject(raw)) {
    ctx.err(path, `expected object, got ${typeName(raw)}`);
    return { name: "", arguments: {} };
  }
  ctx.keys(path, raw, ["name", "arguments"]);
  const name = ctx.str(`${path}.name`, raw.name, { nonEmpty: true });
  let args: ToolCallSpec["arguments"] = {};
  if (!("arguments" in raw)) {
    ctx.err(`${path}.arguments`, "required (object, or a verbatim JSON string)");
  } else if (typeof raw.arguments === "string") {
    args = raw.arguments; // verbatim — malformed-arguments testing is a feature
  } else if (isPlainObject(raw.arguments)) {
    args = raw.arguments as ToolCallSpec["arguments"];
  } else {
    ctx.err(`${path}.arguments`, `expected object or string, got ${typeName(raw.arguments)}`);
  }
  return { name, arguments: args };
}

function parseReply(ctx: Ctx, path: string, raw: unknown): ReplySpec {
  if (typeof raw === "string") {
    checkTemplate(ctx, `${path}`, raw);
    return { text: raw };
  }
  if (!isPlainObject(raw)) {
    ctx.err(path, `expected string or object, got ${typeName(raw)}`);
    return {};
  }
  ctx.keys(path, raw, ["text", "toolCalls", "finishReason"]);
  const reply: ReplySpec = {};
  if ("text" in raw) {
    reply.text = ctx.str(`${path}.text`, raw.text);
    if (typeof raw.text === "string") checkTemplate(ctx, `${path}.text`, raw.text);
  }
  if ("toolCalls" in raw) {
    if (!Array.isArray(raw.toolCalls)) {
      ctx.err(`${path}.toolCalls`, `expected array, got ${typeName(raw.toolCalls)}`);
    } else {
      reply.toolCalls = raw.toolCalls.map((tc, i) =>
        parseToolCall(ctx, `${path}.toolCalls[${i}]`, tc)
      );
    }
  }
  if ("finishReason" in raw) {
    reply.finishReason = ctx.str(`${path}.finishReason`, raw.finishReason, { nonEmpty: true });
  }
  if (reply.text === undefined && reply.toolCalls === undefined) {
    ctx.err(path, "at least one of text/toolCalls required");
  }
  return reply;
}

function checkTemplate(ctx: Ctx, path: string, template: string): void {
  const bad = firstBadPath(template);
  if (bad !== null) {
    ctx.err(
      path,
      `unknown template path "${bad}" (known: message, model, call, seed, server.name)`
    );
  }
}

function parseError(ctx: Ctx, path: string, raw: unknown): ErrorSpec {
  if (!isPlainObject(raw)) {
    ctx.err(path, `expected object, got ${typeName(raw)}`);
    return { status: 500, message: "" };
  }
  ctx.keys(path, raw, ["status", "message", "type", "code", "param", "retryAfterSeconds"]);
  const spec: ErrorSpec = {
    status: "status" in raw ? ctx.int(`${path}.status`, raw.status, 400, 599) : missing(ctx, `${path}.status`, 500),
    message: "message" in raw ? ctx.str(`${path}.message`, raw.message, { nonEmpty: true }) : missing(ctx, `${path}.message`, ""),
  };
  if ("type" in raw) spec.type = ctx.str(`${path}.type`, raw.type, { nonEmpty: true });
  if ("code" in raw) spec.code = raw.code === null ? null : ctx.str(`${path}.code`, raw.code);
  if ("param" in raw) spec.param = raw.param === null ? null : ctx.str(`${path}.param`, raw.param);
  if ("retryAfterSeconds" in raw) {
    spec.retryAfterSeconds = ctx.int(`${path}.retryAfterSeconds`, raw.retryAfterSeconds, 0, 3600);
  }
  return spec;
}

function missing<T>(ctx: Ctx, path: string, fallback: T): T {
  ctx.err(path, "required");
  return fallback;
}

function parseRule(
  ctx: Ctx,
  path: string,
  raw: unknown,
  profiles: Record<string, TimingProfile>
): Rule {
  if (!isPlainObject(raw)) {
    ctx.err(path, `expected object, got ${typeName(raw)}`);
    return {};
  }
  ctx.keys(path, raw, ["label", "when", "times", "profile", "reply", "error"]);
  const rule: Rule = {};
  if ("label" in raw) rule.label = ctx.str(`${path}.label`, raw.label, { nonEmpty: true });
  if ("when" in raw) rule.when = parseWhen(ctx, `${path}.when`, raw.when);
  if ("times" in raw) rule.times = ctx.int(`${path}.times`, raw.times, 1, 1_000_000);
  if ("profile" in raw) {
    rule.profile = ctx.str(`${path}.profile`, raw.profile, { nonEmpty: true });
    if (rule.profile !== "" && resolveProfile(rule.profile, profiles) === null) {
      ctx.err(`${path}.profile`, `unknown profile "${rule.profile}"`);
    }
  }
  const hasReply = "reply" in raw;
  const hasError = "error" in raw;
  if (hasReply === hasError) {
    ctx.err(path, "exactly one of reply/error required");
  }
  if (hasReply) rule.reply = parseReply(ctx, `${path}.reply`, raw.reply);
  if (hasError) rule.error = parseError(ctx, `${path}.error`, raw.error);
  return rule;
}

function parseProfile(ctx: Ctx, path: string, raw: unknown): TimingProfile {
  if (!isPlainObject(raw)) {
    ctx.err(path, `expected object, got ${typeName(raw)}`);
    return { ttftMs: 0, interChunkMs: 0, jitterMs: 0 };
  }
  ctx.keys(path, raw, ["ttftMs", "interChunkMs", "jitterMs", "burst"]);
  const profile: TimingProfile = {
    ttftMs: "ttftMs" in raw ? ctx.int(`${path}.ttftMs`, raw.ttftMs, 0, 600_000) : 0,
    interChunkMs:
      "interChunkMs" in raw ? ctx.int(`${path}.interChunkMs`, raw.interChunkMs, 0, 60_000) : 0,
    jitterMs: "jitterMs" in raw ? ctx.int(`${path}.jitterMs`, raw.jitterMs, 0, 60_000) : 0,
  };
  if ("burst" in raw) {
    if (!isPlainObject(raw.burst)) {
      ctx.err(`${path}.burst`, `expected object, got ${typeName(raw.burst)}`);
    } else {
      ctx.keys(`${path}.burst`, raw.burst, ["size", "pauseMs"]);
      profile.burst = {
        size: "size" in raw.burst ? ctx.int(`${path}.burst.size`, raw.burst.size, 1, 10_000) : missing(ctx, `${path}.burst.size`, 1),
        pauseMs:
          "pauseMs" in raw.burst
            ? ctx.int(`${path}.burst.pauseMs`, raw.burst.pauseMs, 0, 600_000)
            : missing(ctx, `${path}.burst.pauseMs`, 0),
      };
    }
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function parseScenario(raw: unknown): LoadResult {
  const ctx = new Ctx();
  if (!isPlainObject(raw)) {
    throw new ScenarioError([`$: expected object, got ${typeName(raw)}`]);
  }
  ctx.keys("$", raw, ["server", "models", "options", "profiles", "rules", "fallback"]);

  // server
  let server: Scenario["server"] = { name: "", version: "1.0.0" };
  if (!isPlainObject(raw.server)) {
    ctx.err("$.server", "required object with a name");
  } else {
    ctx.keys("$.server", raw.server, ["name", "version", "apiKey"]);
    server = {
      name:
        "name" in raw.server
          ? ctx.str("$.server.name", raw.server.name, { nonEmpty: true })
          : missing(ctx, "$.server.name", ""),
      version:
        "version" in raw.server
          ? ctx.str("$.server.version", raw.server.version, { nonEmpty: true })
          : "1.0.0",
    };
    if ("apiKey" in raw.server) {
      server.apiKey = ctx.str("$.server.apiKey", raw.server.apiKey, { nonEmpty: true });
    }
  }

  // models
  const models: string[] = [];
  if ("models" in raw) {
    if (!Array.isArray(raw.models)) {
      ctx.err("$.models", `expected array, got ${typeName(raw.models)}`);
    } else {
      raw.models.forEach((m, i) => {
        const id = ctx.str(`$.models[${i}]`, m, { nonEmpty: true });
        if (models.includes(id)) {
          ctx.err(`$.models[${i}]`, `duplicate model id "${id}"`);
        }
        models.push(id);
      });
    }
  }

  // profiles
  const profiles: Record<string, TimingProfile> = {};
  if ("profiles" in raw) {
    if (!isPlainObject(raw.profiles)) {
      ctx.err("$.profiles", `expected object, got ${typeName(raw.profiles)}`);
    } else {
      for (const [name, value] of Object.entries(raw.profiles)) {
        if (name === "instant") {
          // `instant` is the guaranteed zero-cost CI escape hatch.
          ctx.err(`$.profiles.instant`, 'the built-in "instant" profile cannot be redefined');
        }
        profiles[name] = parseProfile(ctx, `$.profiles.${name}`, value);
      }
    }
  }

  // options
  const options: Scenario["options"] = {
    defaultProfile: "instant",
    clock: "fixed",
    embeddingDims: 32,
    strictModels: true,
    cors: true,
  };
  if ("options" in raw) {
    if (!isPlainObject(raw.options)) {
      ctx.err("$.options", `expected object, got ${typeName(raw.options)}`);
    } else {
      ctx.keys("$.options", raw.options, [
        "defaultProfile",
        "clock",
        "embeddingDims",
        "strictModels",
        "cors",
      ]);
      const o = raw.options;
      if ("defaultProfile" in o) {
        options.defaultProfile = ctx.str("$.options.defaultProfile", o.defaultProfile, {
          nonEmpty: true,
        });
        if (
          options.defaultProfile !== "" &&
          resolveProfile(options.defaultProfile, profiles) === null
        ) {
          ctx.err(
            "$.options.defaultProfile",
            `unknown profile "${options.defaultProfile}" (built-ins: ${Object.keys(BUILTIN_PROFILES).join(", ")})`
          );
        }
      }
      if ("clock" in o) {
        if (o.clock !== "fixed" && o.clock !== "real") {
          ctx.err("$.options.clock", 'expected "fixed" or "real"');
        } else {
          options.clock = o.clock;
        }
      }
      if ("embeddingDims" in o) {
        options.embeddingDims = ctx.int("$.options.embeddingDims", o.embeddingDims, 1, 4096);
      }
      if ("strictModels" in o) options.strictModels = ctx.bool("$.options.strictModels", o.strictModels);
      if ("cors" in o) options.cors = ctx.bool("$.options.cors", o.cors);
    }
  }

  // rules
  const rules: Rule[] = [];
  if ("rules" in raw) {
    if (!Array.isArray(raw.rules)) {
      ctx.err("$.rules", `expected array, got ${typeName(raw.rules)}`);
    } else {
      raw.rules.forEach((r, i) => {
        rules.push(parseRule(ctx, `$.rules[${i}]`, r, profiles));
      });
    }
  }

  // fallback
  const fallback: Scenario["fallback"] = { mode: "generate", sentences: 3 };
  if ("fallback" in raw) {
    if (!isPlainObject(raw.fallback)) {
      ctx.err("$.fallback", `expected object, got ${typeName(raw.fallback)}`);
    } else {
      ctx.keys("$.fallback", raw.fallback, ["mode", "sentences"]);
      const f = raw.fallback;
      if ("mode" in f) {
        if (f.mode !== "generate" && f.mode !== "echo" && f.mode !== "reject") {
          ctx.err("$.fallback.mode", 'expected "generate", "echo" or "reject"');
        } else {
          fallback.mode = f.mode as FallbackMode;
        }
      }
      if ("sentences" in f) {
        fallback.sentences = ctx.int("$.fallback.sentences", f.sentences, 1, 50);
      }
    }
  }

  if (ctx.issues.length > 0) {
    throw new ScenarioError(ctx.issues);
  }

  // -- warnings (legal but suspicious) --------------------------------------
  rules.forEach((rule, i) => {
    const unconditional =
      (rule.when === undefined || Object.keys(rule.when).length === 0) &&
      rule.times === undefined;
    if (unconditional && i < rules.length - 1) {
      ctx.warn(
        `$.rules[${i}]`,
        "matches every request with no times budget; later rules are unreachable"
      );
    }
    const pattern = rule.when?.model;
    if (
      pattern !== undefined &&
      !pattern.endsWith("*") &&
      options.strictModels &&
      models.length > 0 &&
      !models.includes(pattern)
    ) {
      ctx.warn(
        `$.rules[${i}].when.model`,
        `"${pattern}" is not in $.models, so with strictModels this rule never fires`
      );
    }
  });
  if (rules.length === 0 && fallback.mode === "reject") {
    ctx.warn("$.fallback.mode", 'no rules and mode "reject": every chat request will 404');
  }

  return {
    scenario: { server, models, options, profiles, rules, fallback },
    warnings: ctx.warnings,
  };
}

/** Read + JSON-parse + validate. IO/JSON problems raise ScenarioFileError. */
export function loadScenarioFile(path: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ScenarioFileError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ScenarioFileError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseScenario(raw);
}
