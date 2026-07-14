/**
 * A deliberately tiny `{{…}}` template engine for scripted reply texts.
 * Supported roots: `message` (last user text), `model`, `call` (1-based
 * chat request count this session), `seed` (effective seed), and
 * `server.name`. Unknown roots are a *load-time* error — a typo in a
 * scenario should never survive to call time.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

export interface TemplateScope {
  message: string;
  model: string;
  call: number;
  seed: number;
  server: { name: string };
}

const KNOWN_PATHS = new Set(["message", "model", "call", "seed", "server.name"]);

export class TemplateError extends Error {}

/** Return every `{{path}}` referenced by a template string. */
export function templatePaths(template: string): string[] {
  const paths: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    paths.push(match[1] as string);
  }
  return paths;
}

/** Validate a template's placeholders; returns the first bad path or null. */
export function firstBadPath(template: string): string | null {
  for (const path of templatePaths(template)) {
    if (!KNOWN_PATHS.has(path)) {
      return path;
    }
  }
  return null;
}

/** Render a template against a scope. Throws TemplateError on unknown paths. */
export function renderTemplate(template: string, scope: TemplateScope): string {
  return template.replace(PLACEHOLDER, (_all, rawPath: string) => {
    switch (rawPath) {
      case "message":
        return scope.message;
      case "model":
        return scope.model;
      case "call":
        return String(scope.call);
      case "seed":
        return String(scope.seed);
      case "server.name":
        return scope.server.name;
      default:
        throw new TemplateError(`unknown template path "${rawPath}"`);
    }
  });
}
