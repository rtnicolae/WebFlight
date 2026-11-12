/**
 * Minimal reader for FlightGear PropertyList XML (-set.xml and friends).
 *
 * Follows SimGear's readProperties() closely enough for property defaults:
 * - the root <PropertyList> maps onto the target node;
 * - `include="file"` on any element loads that file into the node first, then the
 *   element's own children are overlaid;
 * - children without `n=` get index = number of same-named siblings already seen in
 *   *this* file (so the first one overlays index 0 coming from an include);
 * - leaf text is the value (types are kept as strings; callers convert).
 */
import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { FgResolver } from "./resolve.ts";

export class PropNode {
  readonly children = new Map<string, PropNode>(); // key: "name[index]"
  value: string | undefined;
  /** type= and alias= attributes. */
  type: string | undefined;
  alias: string | undefined;
  child(name: string, index: number): PropNode {
    const key = `${name}[${index}]`;
    let c = this.children.get(key);
    if (!c) {
      c = new PropNode();
      this.children.set(key, c);
    }
    return c;
  }
}

type OrderedNode = { [tag: string]: OrderedNode[] | string } & { ":@"?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: "#cdata",
  commentPropName: "#comment",
});

export interface ReadOptions {
  /** If given, used for include resolution (FGData-aware). */
  resolver?: FgResolver;
  /** Aircraft folder on disk; `Aircraft/<name>/...` includes resolve here when name matches. */
  aircraftDir: string;
  aircraftName: string;
  warnings?: string[];
}

function resolveInclude(file: string, fromDir: string, opts: ReadOptions): string | null {
  if (opts.resolver) return opts.resolver.resolve(file, fromDir) ?? null;
  const prefix = `Aircraft/${opts.aircraftName}/`;
  const candidates = file.startsWith(prefix)
    ? [path.join(opts.aircraftDir, file.slice(prefix.length))]
    : [path.join(fromDir, file), path.join(opts.aircraftDir, file)];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function readInto(node: PropNode, elements: OrderedNode[], fromDir: string, opts: ReadOptions): void {
  const counters = new Map<string, number>();
  for (const el of elements) {
    const tag = Object.keys(el).find((k) => k !== ":@");
    if (!tag || tag.startsWith("#") || tag.startsWith("?")) continue;
    const attrs = el[":@"] ?? {};
    let index: number;
    if (attrs["n"] !== undefined) index = Number(attrs["n"]);
    else {
      index = counters.get(tag) ?? 0;
    }
    counters.set(tag, Math.max(counters.get(tag) ?? 0, index + 1));
    const child = node.child(tag, index);
    if (attrs["type"]) child.type = attrs["type"];
    if (attrs["alias"]) child.alias = attrs["alias"];
    if (attrs["include"]) loadInclude(child, attrs["include"], fromDir, opts);
    const body = el[tag];
    if (Array.isArray(body)) {
      const text = body
        .map((b) => (typeof b["#text"] === "string" ? b["#text"] : ""))
        .join("")
        .trim();
      const hasElements = body.some((b) => Object.keys(b).some((k) => !k.startsWith("#") && k !== ":@"));
      if (hasElements) readInto(child, body, fromDir, opts);
      else child.value = text;
    }
  }
}

function loadInclude(node: PropNode, file: string, fromDir: string, opts: ReadOptions): void {
  const resolved = resolveInclude(file, fromDir, opts);
  if (!resolved) {
    opts.warnings?.push(`include not found (skipped): ${file}`);
    return;
  }
  readFileInto(node, resolved, opts);
}

export function readFileInto(node: PropNode, file: string, opts: ReadOptions): void {
  const doc = parser.parse(fs.readFileSync(file, "utf8")) as OrderedNode[];
  const root = doc.find((e) => "PropertyList" in e);
  if (!root) throw new Error(`${file}: no <PropertyList> root`);
  const attrs = root[":@"] ?? {};
  if (attrs["include"]) loadInclude(node, attrs["include"], path.dirname(file), opts);
  readInto(node, root["PropertyList"] as OrderedNode[], path.dirname(file), opts);
}

export function readPropertyList(file: string, opts: ReadOptions): PropNode {
  const root = new PropNode();
  readFileInto(root, file, opts);
  return root;
}

/** Look up "/a/b[1]/c" (missing index = 0). */
export function getProp(root: PropNode, propPath: string): string | undefined {
  let node: PropNode | undefined = root;
  for (const part of propPath.split("/").filter(Boolean)) {
    const m = /^([^[\]]+)(?:\[(\d+)\])?$/.exec(part);
    if (!m) return undefined;
    node = node.children.get(`${m[1]}[${m[2] ?? 0}]`);
    if (!node) return undefined;
  }
  return node.value;
}

/** Convert a PropertyList leaf to a number the way SimGear would for double/bool reads. */
export function propToNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true") return 1;
  if (s === "false") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** JSON form for the runtime (see fg-host PNode): ordered children, index, value, type, alias. */
export interface PNodeJson {
  n: string;
  i: number;
  v?: string;
  t?: string;
  a?: string;
  c?: PNodeJson[];
}

export function toPNode(node: PropNode, name = "PropertyList", index = 0, skip: (path: string) => boolean = () => false, path = ""): PNodeJson {
  const out: PNodeJson = { n: name, i: index };
  if (node.value !== undefined && node.children.size === 0) out.v = node.value;
  if (node.type) out.t = node.type;
  if (node.alias) out.a = node.alias;
  const kids: PNodeJson[] = [];
  for (const [key, child] of node.children) {
    const m = /^(.*)\[(\d+)\]$/.exec(key)!;
    const childPath = `${path}/${m[1]}${m[2] !== "0" ? `[${m[2]}]` : ""}`;
    if (skip(childPath)) continue;
    kids.push(toPNode(child, m[1]!, Number(m[2]), skip, childPath));
  }
  if (kids.length) out.c = kids;
  return out;
}
