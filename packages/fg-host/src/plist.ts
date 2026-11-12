/**
 * PropertyList XML as JSON (written by the converter, read here). Children keep document
 * order; `i` is the SimGear index (from n= or position among same-named siblings).
 */
export interface PNode {
  /** Element name. */
  n: string;
  /** Index. */
  i: number;
  /** Text value of a leaf. */
  v?: string;
  /** type= attribute (double, bool, int, string, ...). */
  t?: string;
  /** alias= attribute (absolute property path). */
  a?: string;
  c?: PNode[];
}

export const kids = (p: PNode | undefined, name?: string): PNode[] => (p?.c ?? []).filter((c) => name === undefined || c.n === name);
export const kid = (p: PNode | undefined, name: string, index = 0): PNode | undefined => p?.c?.find((c) => c.n === name && c.i === index);
export const text = (p: PNode | undefined): string => (p?.v ?? "").trim();
export const kidText = (p: PNode | undefined, name: string): string | undefined => {
  const k = kid(p, name);
  return k ? text(k) : undefined;
};
export const kidNum = (p: PNode | undefined, name: string, def: number): number => {
  const s = kidText(p, name);
  if (s === undefined || s === "") return def;
  const v = Number(s);
  return Number.isFinite(v) ? v : def;
};
export const kidBool = (p: PNode | undefined, name: string, def: boolean): boolean => {
  const s = kidText(p, name);
  return s === undefined || s === "" ? def : parseBool(s);
};
export const parseBool = (s: string): boolean => {
  const t = s.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false" || t === "") return false;
  const v = Number(t);
  return Number.isFinite(v) ? v !== 0 : false;
};
/** Look up "a/b[1]/c" relative to a node. */
export function at(p: PNode | undefined, path: string): PNode | undefined {
  let n = p;
  for (const part of path.split("/").filter(Boolean)) {
    const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(part);
    if (!m || !n) return undefined;
    n = kid(n, m[1]!, Number(m[2] ?? 0));
  }
  return n;
}
