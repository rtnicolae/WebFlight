// Web-standard globals also present in Node ≥ 18 (the package has no DOM lib).
declare function fetch(url: string, init?: { signal?: unknown }): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }>;
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;
declare class AbortController {
  readonly signal: unknown;
  abort(): void;
}
declare class URL {
  constructor(url: string, base?: string | URL);
  readonly href: string;
  readonly protocol: string;
}
interface ImportMeta {
  readonly url: string;
}
