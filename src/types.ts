/**
 * Shared types: JSON primitives, the scenario file model, and the
 * OpenAI-compatible wire shapes stublm emits. Wire shapes deliberately use
 * snake_case field names — they are serialized as-is and must match what
 * real clients parse.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Scenario file model (validated shape, post-loader)
// ---------------------------------------------------------------------------

/** Timing profile for streamed responses; all values in milliseconds. */
export interface TimingProfile {
  /** Delay before the first SSE chunk (time to first token). */
  ttftMs: number;
  /** Base delay between subsequent chunks. */
  interChunkMs: number;
  /** Max seeded jitter added to each inter-chunk delay (uniform [0, jitterMs]). */
  jitterMs: number;
  /** Optional burst shape: `size` quick chunks, then a `pauseMs` gap. */
  burst?: { size: number; pauseMs: number };
}

/** Exactly one of the three keys is set (enforced by the loader). */
export interface TextMatch {
  equals?: string;
  contains?: string;
  regex?: string;
}

export interface RuleWhen {
  /** Exact model id, or a trailing-`*` glob such as `stub-*`. */
  model?: string;
  /** Matched against the text of the last `user` message. */
  lastUser?: TextMatch;
  /** Matched against the concatenated `system` message text. */
  system?: TextMatch;
  /** Matches when the request declares a tool with this function name. */
  hasTool?: string;
  /** Matches only streaming (`true`) or only non-streaming (`false`) requests. */
  stream?: boolean;
}

export interface ToolCallSpec {
  name: string;
  /** Object is serialized; a string is used verbatim as the arguments JSON. */
  arguments: JsonObject | string;
}

export interface ReplySpec {
  text?: string;
  toolCalls?: ToolCallSpec[];
  finishReason?: string;
}

export interface ErrorSpec {
  status: number;
  message: string;
  type?: string;
  code?: string | null;
  param?: string | null;
  /** Adds a `Retry-After` header — lets clients exercise backoff paths. */
  retryAfterSeconds?: number;
}

export interface Rule {
  /** Shown by `inspect` and in the `x-stublm-rule` response header. */
  label?: string;
  when?: RuleWhen;
  /** Serve at most N times, then fall through to later rules / the fallback. */
  times?: number;
  /** Timing profile name for this rule's streamed responses. */
  profile?: string;
  reply?: ReplySpec;
  error?: ErrorSpec;
}

export type FallbackMode = "generate" | "echo" | "reject";

export interface ScenarioOptions {
  /** Profile used when neither the rule nor the request names one. */
  defaultProfile: string;
  /** "fixed" pins `created` to a constant so runs are byte-identical. */
  clock: "fixed" | "real";
  /** Default vector width for /v1/embeddings (request `dimensions` wins). */
  embeddingDims: number;
  /** Reject models outside `models` with a 404 (only when `models` is set). */
  strictModels: boolean;
  /** Emit permissive CORS headers so browser UIs can call the stub. */
  cors: boolean;
}

export interface Scenario {
  server: { name: string; version: string; apiKey?: string };
  models: string[];
  options: ScenarioOptions;
  /** User profiles merged over the built-ins (user names win). */
  profiles: Record<string, TimingProfile>;
  rules: Rule[];
  fallback: { mode: FallbackMode; sentences: number };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible request shapes (the subset stublm interprets)
// ---------------------------------------------------------------------------

/** Unknown extra fields on requests are accepted and ignored, as a real
 * server would; only the fields below influence stublm's behavior. */
export interface ChatMessage {
  role: string;
  /** Plain string or an array of content parts ({type:"text",text:…}). */
  content?: JsonValue;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  seed?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  n?: number;
  tools?: JsonValue[];
}

export interface EmbeddingsRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
}

// ---------------------------------------------------------------------------
// Engine outcomes (what the transport layer renders)
// ---------------------------------------------------------------------------

export interface ErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export interface ErrorOutcome {
  kind: "error";
  status: number;
  body: ErrorBody;
  headers: Record<string, string>;
  ruleRef: string;
}

export interface CompletionOutcome {
  kind: "completion";
  /** Non-streaming chat.completion object (also built for stream requests). */
  response: JsonObject;
  /** True when the client asked for SSE. */
  stream: boolean;
  /** Chunk objects, in order, for the SSE path (empty when !stream). */
  chunks: JsonObject[];
  /** Planned delay before each chunk in `chunks` (same length). */
  delays: number[];
  /** Which profile produced `delays`. */
  profileName: string;
  ruleRef: string;
  requestId: string;
}

export type ChatOutcome = ErrorOutcome | CompletionOutcome;

export interface EmbeddingsOutcome {
  kind: "embeddings";
  response: JsonObject;
  requestId: string;
}

/** One line of the --record JSONL audit trail. */
export interface RequestRecord {
  seq: number;
  endpoint: string;
  model: string | null;
  stream: boolean;
  status: number;
  rule: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
}
