/**
 * Builds the mountain-wave field (waves.ts) round a point off the main thread: Terrarium heights
 * at zoom 10 (~110 m, ample for a 400 m grid) over the 102 km square, the day's pressure levels.
 */
import { buildWaveField, TerrariumTerrain, type SoundingLevel } from "@webflight/environment";

const terrain = new TerrariumTerrain({ zoom: 10 });

self.onmessage = async (ev: MessageEvent<{ id: number; latDeg: number; lonDeg: number; levels: SoundingLevel[] }>) => {
  const { id, latDeg, lonDeg, levels } = ev.data;
  try {
    await terrain.load(latDeg, lonDeg, 75_000);
    const t0 = performance.now();
    const field = buildWaveField({ centerLatDeg: latDeg, centerLonDeg: lonDeg, heightAt: (la, lo) => terrain.heightAt(la, lo), levels });
    const ms = performance.now() - t0;
    if (field) (self as unknown as Worker).postMessage({ id, field, ms }, [field.data.buffer]);
    else (self as unknown as Worker).postMessage({ id, field: null, ms });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, field: null, error: e instanceof Error ? e.message : String(e) });
  }
};
