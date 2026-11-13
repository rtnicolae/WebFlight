/**
 * FlightGear <binding> execution for cockpit clicks, knobs and sliders (subset of
 * src/Main/fg_commands.cxx): property-toggle, property-assign, property-adjust,
 * property-multiply, property-cycle, property-swap, property-interpolate, nasal.
 * UI-only commands (set-tooltip, dialog-show, ...) are ignored.
 */
import { compileCondition, type CompileContext } from "./expr.ts";
import { kid, kids, kidText, parseBool, text, type PNode } from "./plist.ts";
import { toNumber, type PropValue } from "./props.ts";

export interface BindingHost {
  ctx: CompileContext & { tree: import("./props.ts").PropertyTree };
  runNasal(script: string): boolean;
  interpolate(path: string, ...steps: number[]): void;
}

export interface BindingArgs {
  /** Knob/slider/wheel increment (FG passes it as "offset"). */
  offset?: number;
}

const IGNORED = new Set(["set-tooltip", "dialog-show", "dialog-close", "update-hover", "tooltip-timeout", "null"]);

export function runBinding(b: PNode, host: BindingHost, args: BindingArgs = {}): string | undefined {
  const cond = kid(b, "condition");
  if (cond && !compileCondition(cond, host.ctx)()) return undefined;
  const cmd = kidText(b, "command") ?? "";
  const tree = host.ctx.tree;
  const target = kidText(b, "property");
  const ref = target ? tree.node(target) : undefined;
  const num = (name: string) => {
    const s = kidText(b, name);
    return s === undefined || s === "" ? undefined : toNumber(s);
  };
  switch (cmd) {
    case "property-toggle":
      ref?.set(!ref.bool());
      return;
    case "property-assign": {
      if (!ref) return;
      const src = kid(b, "property", 1);
      if (src) ref.set(tree.get(text(src)) ?? 0);
      else {
        const v = kidText(b, "value") ?? "";
        const n = Number(v);
        ref.set(v !== "" && Number.isFinite(n) ? n : v === "true" ? true : v === "false" ? false : v);
      }
      return;
    }
    case "property-adjust": {
      if (!ref) return;
      const amount = num("step") ?? (args.offset ?? num("offset") ?? 0) * (num("factor") ?? 1);
      let v = ref.num() + amount;
      const min = num("min"), max = num("max");
      const wrap = kidText(b, "wrap") !== undefined && parseBool(kidText(b, "wrap")!);
      if (wrap && min !== undefined && max !== undefined && max > min) {
        const w = max - min;
        v = ((((v - min) % w) + w) % w) + min;
      } else {
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
      }
      ref.set(v);
      return;
    }
    case "property-multiply":
      if (ref) ref.set(ref.num() * (num("factor") ?? 1));
      return;
    case "property-cycle": {
      if (!ref) return;
      const values = kids(b, "value").map((v) => text(v));
      if (!values.length) return;
      const cur = ref.str();
      const i = values.findIndex((v) => v === cur || (Number(v) === toNumber(cur) && cur !== ""));
      const next = values[(i + 1) % values.length]!;
      const n = Number(next);
      ref.set(next !== "" && Number.isFinite(n) ? n : next);
      return;
    }
    case "property-swap": {
      const [a, c] = kids(b, "property").map((p) => tree.node(text(p)));
      if (a && c) {
        const t: PropValue = a.get() ?? 0;
        a.set(c.get() ?? 0);
        c.set(t);
      }
      return;
    }
    case "property-interpolate": {
      if (!target) return;
      const src = kid(b, "property", 1);
      const to = src ? tree.num(text(src)) : (num("value") ?? 0);
      const time = num("time") ?? (num("rate") ? Math.abs(to - tree.num(target)) / num("rate")! : 0);
      host.interpolate(target, to, time);
      return;
    }
    case "nasal": {
      const script = kidText(b, "script") ?? "";
      if (!host.runNasal(script)) return `Nasal not ported: ${script.trim().slice(0, 80)}`;
      return;
    }
    default:
      if (!IGNORED.has(cmd)) return `binding command not supported: ${cmd}`;
      return;
  }
}

/**
 * Run the bindings of an <action> (or <increase>/<decrease>) element. On release
 * (`phase: "up"`) the <mod-up> bindings run instead. Returns problems for logging.
 */
export function runAction(action: PNode, host: BindingHost, phase: "down" | "up", args: BindingArgs = {}): string[] {
  const problems: string[] = [];
  const list = phase === "up" ? kids(kid(action, "mod-up"), "binding") : kids(action, "binding");
  for (const b of list) {
    const p = runBinding(b, host, args);
    if (p) problems.push(p);
  }
  return problems;
}
