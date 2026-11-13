// Web-standard globals also present in Node ≥ 18 (the package has no DOM lib).
declare function fetch(url: string): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
declare function setTimeout(fn: () => void, ms: number): unknown;
