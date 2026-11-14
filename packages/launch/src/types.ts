import type { Vec3 } from "@webflight/fdm-core";

/** A rope force on the glider: magnitude [N] along a unit vector in body axes (x nose, y right, z down). */
export interface HitchForce {
  forceN: number;
  dirBody: Vec3;
}

/** FG message channels (hitch.nas write_message): pilot, winch-driver, launch-signaller, ai-plane, system. */
export type MessageSink = (channel: "pilot" | "winch-driver" | "launch-signaller" | "ai-plane" | "remote-ac" | "system", text: string) => void;
