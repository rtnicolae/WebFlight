/// <reference lib="webworker" />
/** Paints Web Mercator imagery tiles from Terrarium heights (see landcover.ts). */
import { TerrariumTerrain } from "@webflight/environment";
import { paintTile, type Sun } from "./landcover.ts";

declare const self: DedicatedWorkerGlobalScope;
const terrain = new TerrariumTerrain({ zoom: 13, maxTiles: 96 });

export interface PaintRequest {
  id: number;
  x: number;
  y: number;
  z: number;
  sun: Sun;
}

self.onmessage = async (ev: MessageEvent<PaintRequest>) => {
  const { id, x, y, z, sun } = ev.data;
  try {
    const size = 256;
    const heights = await terrain.heightGrid(z, x, y, size);
    const px = paintTile(x, y, z, size, heights, sun);
    const canvas = new OffscreenCanvas(size, size);
    canvas.getContext("2d")!.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    // Pre-flipped, as Cesium expects imagery ImageBitmaps (see detail-worker.ts).
    const bitmap = await createImageBitmap(canvas, { imageOrientation: "flipY" });
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};
