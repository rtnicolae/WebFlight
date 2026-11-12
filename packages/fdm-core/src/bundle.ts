/**
 * Read a converter bundle (manifest.json + jsbsim/...) through any text reader
 * (fetch in a worker, fs in Node). The manifest type lives here so fdm-core does not
 * depend on the converter.
 */
import type { AircraftFiles } from "./fdm.ts";
import type { AirbrakeRoute } from "./fg-bridge.ts";

export interface BundleManifestCore {
  format: 1;
  aircraft: string;
  setFile: string;
  description?: string;
  fdm: { model: string; files: string[]; hostProperties: Record<string, number> };
  model: { file: string; animations: unknown[]; properties: Record<string, number | string | null> };
  input: { airbrake: AirbrakeRoute };
}

export async function loadBundleAircraft(readText: (rel: string) => Promise<string>): Promise<{ manifest: BundleManifestCore; files: AircraftFiles }> {
  const manifest = JSON.parse(await readText("manifest.json")) as BundleManifestCore;
  if (manifest.format !== 1) throw new Error(`unsupported bundle format ${String(manifest.format)}`);
  const entries = await Promise.all(manifest.fdm.files.map(async (f) => [f, await readText(`jsbsim/${f}`)] as const));
  return {
    manifest,
    files: {
      aircraft: manifest.aircraft,
      model: manifest.fdm.model,
      files: Object.fromEntries(entries),
      hostProperties: manifest.fdm.hostProperties,
    },
  };
}
