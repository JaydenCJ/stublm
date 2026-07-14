/**
 * Public programmatic API. Everything the CLI can do is reachable from
 * code: load a scenario, drive the engine in-process (no sockets at all),
 * or start the loopback HTTP server inside a test suite and point an
 * OpenAI-compatible client at `http://127.0.0.1:<port>/v1`.
 */

export { StubEngine, FIXED_EPOCH } from "./engine.js";
export type { ChatCallOptions } from "./engine.js";
export {
  ScenarioError,
  ScenarioFileError,
  loadScenarioFile,
  parseScenario,
} from "./scenario.js";
export type { LoadResult } from "./scenario.js";
export { createStubServer, serve } from "./server.js";
export type { RunningServer, ServeOptions } from "./server.js";
export { encodeDone, encodeEvent, streamFrames } from "./sse.js";
export { BUILTIN_PROFILES, resolveProfile, schedule, totalDuration } from "./timing.js";
export { countMessageTokens, countTokens, pieces } from "./tokenizer.js";
export { generateEmbedding, generateSentence, generateText } from "./generator.js";
export { Rng, fnv1a, hexId, mixSeed } from "./rng.js";
export { lastUserText, messageText, modelMatches, textMatches, whenMatches } from "./matcher.js";
export { renderTemplate, templatePaths, firstBadPath, TemplateError } from "./template.js";
export type { TemplateScope } from "./template.js";
export { STARTER_FILENAME, STARTER_SCENARIO, starterJson } from "./starter.js";
export { VERSION } from "./version.js";
export type {
  ChatMessage,
  ChatOutcome,
  ChatRequest,
  CompletionOutcome,
  EmbeddingsOutcome,
  EmbeddingsRequest,
  ErrorBody,
  ErrorOutcome,
  ErrorSpec,
  FallbackMode,
  JsonObject,
  JsonValue,
  ReplySpec,
  RequestRecord,
  Rule,
  RuleWhen,
  Scenario,
  ScenarioOptions,
  TextMatch,
  TimingProfile,
  ToolCallSpec,
} from "./types.js";
