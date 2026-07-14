/**
 * Rule matching: pure predicates over an incoming chat request. The loader
 * has already validated shapes and compiled nothing — regexes are compiled
 * here per call site but cached by the scenario loader's validation pass
 * having guaranteed they parse. All matching is case-sensitive and exact;
 * a stub that "helpfully" fuzzy-matches would hide client bugs.
 */

import type { ChatMessage, ChatRequest, RuleWhen, TextMatch } from "./types.js";

/** Extract plain text from a message content value (string or parts array). */
export function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.join("");
  }
  return "";
}

/** Text of the last message with role "user" ("" when there is none). */
export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message !== undefined && message.role === "user") {
      return messageText(message.content);
    }
  }
  return "";
}

/** Concatenated text of all "system" messages. */
export function systemText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      parts.push(messageText(message.content));
    }
  }
  return parts.join("\n");
}

/** Apply a TextMatch (exactly one key, loader-enforced) to a string. */
export function textMatches(match: TextMatch, text: string): boolean {
  if (match.equals !== undefined) {
    return text === match.equals;
  }
  if (match.contains !== undefined) {
    return text.includes(match.contains);
  }
  if (match.regex !== undefined) {
    return new RegExp(match.regex).test(text);
  }
  return true;
}

/** Exact model id, or a trailing-`*` glob (`stub-*` matches `stub-mini`). */
export function modelMatches(pattern: string, model: string): boolean {
  if (pattern.endsWith("*")) {
    return model.startsWith(pattern.slice(0, -1));
  }
  return model === pattern;
}

/** Does the request declare a tool with this function name? */
function requestHasTool(request: ChatRequest, name: string): boolean {
  if (!Array.isArray(request.tools)) {
    return false;
  }
  for (const tool of request.tools) {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
      continue;
    }
    const fn = (tool as { function?: unknown }).function;
    if (
      typeof fn === "object" &&
      fn !== null &&
      (fn as { name?: unknown }).name === name
    ) {
      return true;
    }
  }
  return false;
}

/** True when every clause of `when` holds. An absent `when` matches all. */
export function whenMatches(
  when: RuleWhen | undefined,
  request: ChatRequest
): boolean {
  if (when === undefined) {
    return true;
  }
  if (when.model !== undefined && !modelMatches(when.model, request.model)) {
    return false;
  }
  if (
    when.lastUser !== undefined &&
    !textMatches(when.lastUser, lastUserText(request.messages))
  ) {
    return false;
  }
  if (
    when.system !== undefined &&
    !textMatches(when.system, systemText(request.messages))
  ) {
    return false;
  }
  if (when.hasTool !== undefined && !requestHasTool(request, when.hasTool)) {
    return false;
  }
  if (when.stream !== undefined && when.stream !== (request.stream === true)) {
    return false;
  }
  return true;
}
