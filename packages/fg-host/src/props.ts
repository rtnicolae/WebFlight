/**
 * A FlightGear-style property tree: absolute paths, typed-ish values, aliases, listeners,
 * and mount points (JSBSim's tree appears under /fdm/jsbsim like in FlightGear).
 *
 * Nodes are objects, so compiled expressions and property rules hold direct references
 * instead of re-resolving paths every update.
 */

export type PropValue = number | string | boolean;

export interface PropRef {
  readonly path: string;
  get(): PropValue | undefined;
  set(v: PropValue): void;
  /** Value as SimGear's getDoubleValue(): bool→0/1, numeric strings parsed, else 0. */
  num(): number;
  bool(): boolean;
  str(): string;
  /** True if the node has ever been written (or exists in a mount). */
  readonly exists: boolean;
}

export function toNumber(v: PropValue | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return 0;
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}
export function toBool(v: PropValue | undefined): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  if (t === "true") return true;
  const x = parseFloat(t);
  return Number.isFinite(x) ? x !== 0 : false;
}
export function toStr(v: PropValue | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Canonical absolute path: leading "/", no "[0]", no trailing slash. */
export function normPath(p: string): string {
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/").replace(/\[0\]/g, "").replace(/\/$/, "");
  return s || "/";
}

type Listener = (ref: PropRef, value: PropValue) => void;

class Node implements PropRef {
  value: PropValue | undefined;
  alias: Node | undefined;
  listeners: { fn: Listener; changedOnly: boolean }[] | undefined;
  constructor(readonly path: string, private readonly tree: PropertyTree) {}
  get exists(): boolean {
    return this.alias ? this.alias.exists : this.value !== undefined;
  }
  get(): PropValue | undefined {
    return this.alias ? this.alias.get() : this.value;
  }
  set(v: PropValue): void {
    if (this.alias) return this.alias.set(v);
    const old = this.value;
    this.value = v;
    if (this.listeners) this.tree.fire(this, v, old !== v);
  }
  num(): number {
    return toNumber(this.get());
  }
  bool(): boolean {
    return toBool(this.get());
  }
  str(): string {
    return toStr(this.get());
  }
}

/** A subtree served by someone else (JSBSim). Paths are relative to the mount point. */
export interface Mount {
  get(rel: string): number | undefined;
  set(rel: string, v: number): void;
}

class MountedNode implements PropRef {
  constructor(
    readonly path: string,
    private readonly mount: Mount,
    private readonly rel: string,
  ) {}
  get exists(): boolean {
    return this.mount.get(this.rel) !== undefined;
  }
  get(): PropValue | undefined {
    return this.mount.get(this.rel);
  }
  set(v: PropValue): void {
    this.mount.set(this.rel, toNumber(v));
  }
  num(): number {
    return this.mount.get(this.rel) ?? 0;
  }
  bool(): boolean {
    return this.num() !== 0;
  }
  str(): string {
    return toStr(this.get());
  }
}

export class PropertyTree {
  private readonly nodes = new Map<string, PropRef>();
  private readonly mounts: [string, Mount][] = [];
  private firing = 0;

  /** Mount a subtree, e.g. mount("/fdm/jsbsim", jsbsimMount). */
  mount(prefix: string, m: Mount): void {
    this.mounts.push([normPath(prefix) + "/", m]);
  }

  node(path: string): PropRef {
    const p = normPath(path);
    let n = this.nodes.get(p);
    if (!n) {
      const mnt = this.mounts.find(([pre]) => p.startsWith(pre));
      n = mnt ? new MountedNode(p, mnt[1], p.slice(mnt[0].length)) : new Node(p, this);
      this.nodes.set(p, n);
    }
    return n;
  }

  get(path: string): PropValue | undefined {
    return this.node(path).get();
  }
  num(path: string): number {
    return this.node(path).num();
  }
  bool(path: string): boolean {
    return this.node(path).bool();
  }
  str(path: string): string {
    return this.node(path).str();
  }
  set(path: string, v: PropValue): void {
    this.node(path).set(v);
  }
  /** Set only if the node has no value yet (Nasal's initNode / props defaults). */
  init(path: string, v: PropValue): PropRef {
    const n = this.node(path);
    if (!n.exists) n.set(v);
    return n;
  }

  /** Make `path` an alias of `target` (SGPropertyNode::alias). */
  alias(path: string, target: string): void {
    const n = this.node(path);
    const t = this.node(target);
    if (n instanceof Node && t instanceof Node && n !== t) n.alias = t;
  }

  /**
   * setlistener(): called on every write (changedOnly=false) or on value changes.
   * Returns a function that removes the listener.
   */
  listen(path: string, fn: Listener, opts: { changedOnly?: boolean; initial?: boolean } = {}): () => void {
    const n = this.node(path);
    const target = n instanceof Node ? (n.alias ?? n) : undefined;
    if (!(target instanceof Node)) throw new Error(`cannot listen to mounted property ${path}`);
    const entry = { fn, changedOnly: opts.changedOnly ?? false };
    (target.listeners ??= []).push(entry);
    if (opts.initial) fn(target, target.get() ?? 0);
    return () => {
      const l = target.listeners;
      if (l) l.splice(l.indexOf(entry), 1);
    };
  }

  /** @internal */
  fire(n: Node, v: PropValue, changed: boolean): void {
    if (this.firing > 32) return; // recursion guard, like SimGear's listener depth limit
    this.firing++;
    try {
      for (const l of [...(n.listeners ?? [])]) if (changed || !l.changedOnly) l.fn(n, v);
    } finally {
      this.firing--;
    }
  }

  /** All plain (non-mounted) paths with values, for debugging/tests. */
  dump(prefix = "/"): Record<string, PropValue> {
    const out: Record<string, PropValue> = {};
    for (const [p, n] of this.nodes) if (p.startsWith(prefix) && n instanceof Node && n.value !== undefined) out[p] = n.value;
    return out;
  }
}
