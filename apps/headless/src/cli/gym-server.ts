/**
 * The gym over stdio, one JSON object per line (for Python or any other language):
 *   → {"cmd":"make","task":"landing"|"aerotow","decision_hz":10,"loadout":"solo"}
 *   ← {"observation":{"names","low","high"},"action":{…},"max_seconds":300}
 *   → {"cmd":"reset","seed":42}            ← {"obs":[…],"info":{…}}
 *   → {"cmd":"step","action":[…]}          ← {"obs":[…],"reward":r,"terminated":b,"truncated":b,"info":{…}}
 *   → {"cmd":"close"}                      ← {"ok":true}  (and exit)
 * Errors come back as {"error":"…"}. Logs go to stderr. Numbers are JSON doubles, which
 * round-trip exactly, so episodes stay bit-identical across the pipe.
 */
import readline from "node:readline";
import type { GliderEnv } from "@webflight/gym";
import { makeGym } from "../gym.ts";

let env: GliderEnv | undefined;
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const queue: string[] = [];
let busy = false;

async function handle(line: string): Promise<void> {
  const m = JSON.parse(line) as { cmd: string; task?: string; decision_hz?: number; loadout?: "solo" | "dual"; seed?: number; action?: number[] };
  switch (m.cmd) {
    case "make":
      env?.close();
      env = await makeGym(m.task ?? "landing", { ...(m.decision_hz ? { decisionHz: m.decision_hz } : {}), ...(m.loadout ? { loadout: m.loadout } : {}) });
      send({ observation: env.observation, action: env.action, max_seconds: env.task.maxSeconds, task: env.task.name });
      return;
    case "reset": {
      if (!env) throw new Error("make first");
      const r = await env.reset(m.seed ?? 0);
      send({ obs: [...r.obs], info: r.info });
      return;
    }
    case "step": {
      if (!env) throw new Error("make first");
      const r = env.step(m.action ?? []);
      send({ obs: [...r.obs], reward: r.reward, terminated: r.terminated, truncated: r.truncated, info: r.info });
      return;
    }
    case "close":
      env?.close();
      send({ ok: true });
      process.exit(0);
    default:
      throw new Error(`unknown cmd ${m.cmd}`);
  }
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const line = queue.shift()!;
    try {
      await handle(line);
    } catch (e) {
      send({ error: e instanceof Error ? e.message : String(e) });
    }
  }
  busy = false;
}

rl.on("line", (l) => {
  if (l.trim()) {
    queue.push(l);
    void pump();
  }
});
rl.on("close", () => process.exit(0));
