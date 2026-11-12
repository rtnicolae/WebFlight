/**
 * Nasal file → TypeScript port. Keys are FG_ROOT-relative paths as listed under /nasal in
 * an aircraft's -set.xml. "not-applicable" marks files whose job doesn't exist here
 * (FlightGear UI, joystick config, multiplayer, the Nasal framework itself). Files absent
 * from this map are reported as not ported.
 */
import type { AircraftScript } from "../host.ts";
import { ask21Doors, ask21Electrical, ask21GroundHandling, ask21Immat, ask21Limits, ask21Main, ask21TeVario, ilecSc7 } from "./ask21.ts";

export const NASAL_PORTS: Record<string, AircraftScript | "not-applicable"> = {
  // ASK21
  "Aircraft/ASK21/Nasal/ask21.nas": ask21Main,
  "Aircraft/ASK21/Nasal/limits.nas": ask21Limits,
  "Aircraft/ASK21/Nasal/groundhandling.nas": ask21GroundHandling,
  "Aircraft/ASK21/Nasal/te-vario.nas": ask21TeVario,
  "Aircraft/ASK21/Nasal/electrical.nas": ask21Electrical,
  "Aircraft/ASK21/Nasal/door.nas": ask21Doors,
  "Aircraft/ASK21/Nasal/immat.nas": ask21Immat,
  "Aircraft/ASK21/Nasal/jsoverride.nas": "not-applicable", // rewrites FG joystick bindings
  "Aircraft/ASK21/Nasal/ask21-dual-control.nas": "not-applicable", // multiplayer dual control
  // FGData
  "Aircraft/Instruments-3d/glider/vario/ilec-sc7/ilec-sc7.nas": ilecSc7,
  "Aircraft/Generic/updateloop.nas": "not-applicable", // framework, replaced by fg-host timers
  "Aircraft/Generic/DualControl/dual-control-tools.nas": "not-applicable",
  "Aircraft/Generic/DualControl/pilot-dual-control.nas": "not-applicable",
  "gui/dialogs/fuelpayload.nas": "not-applicable", // FG dialog
};
