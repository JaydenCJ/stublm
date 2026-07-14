/**
 * Minimal ambient declarations for the handful of Node.js built-ins this
 * project uses. Declaring them in-repo keeps `typescript` the only
 * devDependency (no `@types/node`); the surface below is intentionally
 * restricted to exactly what `src/` calls, so a typo against a real Node
 * API still fails to compile.
 */

interface StdoutLike {
  write(chunk: string): boolean;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    setEncoding(encoding: "utf8"): void;
    on(event: "data", cb: (chunk: string) => void): void;
    on(event: "end" | "close", cb: () => void): void;
  }
  export interface ServerResponse {
    /** True once the underlying socket is gone (client disconnected). */
    readonly destroyed: boolean;
    writeHead(status: number, headers?: Record<string, string>): void;
    write(chunk: string): boolean;
    end(chunk?: string): void;
  }
  export interface AddressInfo {
    port: number;
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): Server;
    close(cb?: () => void): void;
    address(): AddressInfo | string | null;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void
  ): Server;
}

declare var process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  stdout: StdoutLike;
  on(event: string, cb: () => void): void;
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare function setTimeout(cb: () => void, ms: number): unknown;
