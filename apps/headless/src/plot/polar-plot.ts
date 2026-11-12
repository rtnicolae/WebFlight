import type { PolarPoint, PolarSummary, SimPolarPoint } from "../glide.ts";
import { Canvas, hex, type Rgb } from "./raster.ts";

// Reference palette (dataviz skill, light mode): series 1 blue, series 2 orange.
const C = {
  surface: hex("#fcfcfb"),
  text: hex("#0b0b0b"),
  text2: hex("#52514e"),
  grid: hex("#e6e5e0"),
  axis: hex("#b9b8b1"),
  trim: hex("#2a78d6"),
  sim: hex("#eb6834"),
};

interface Panel {
  x: number; y: number; w: number; h: number;
  xMin: number; xMax: number; yMin: number; yMax: number;
  /** Draw y increasing downwards (sink polars are drawn this way). */
  invertY?: boolean;
}
const px = (p: Panel, v: number) => p.x + ((v - p.xMin) / (p.xMax - p.xMin)) * p.w;
const py = (p: Panel, v: number) => {
  const f = (v - p.yMin) / (p.yMax - p.yMin);
  return p.invertY ? p.y + f * p.h : p.y + p.h - f * p.h;
};

function axes(c: Canvas, p: Panel, xStep: number, yStep: number, yLabel: string, xLabel: string | null, yFmt: (v: number) => string) {
  for (let v = Math.ceil(p.yMin / yStep) * yStep; v <= p.yMax + 1e-9; v += yStep) {
    c.rect(p.x, py(p, v) - 0.5, p.w, 1, C.grid);
    c.text(yFmt(v), p.x - 10, py(p, v) - 7, C.text2, { align: "right" });
  }
  for (let v = Math.ceil(p.xMin / xStep) * xStep; v <= p.xMax + 1e-9; v += xStep) {
    c.rect(px(p, v) - 0.5, p.y, 1, p.h, C.grid);
    if (xLabel !== null) c.text(String(v), px(p, v), p.y + p.h + 10, C.text2, { align: "center" });
  }
  c.rect(p.x, p.invertY ? p.y : p.y + p.h - 1, p.w, 1, C.axis);
  c.text(yLabel, p.x - 78, p.y + p.h / 2, C.text2, { vertical: true, align: "center" });
  if (xLabel) c.text(xLabel, p.x + p.w / 2, p.y + p.h + 34, C.text2, { align: "center" });
}

function series(c: Canvas, p: Panel, pts: readonly PolarPoint[], f: (q: PolarPoint) => number, color: Rgb, kind: "line" | "dots") {
  const xy = pts.map((q) => [px(p, q.easKmh), py(p, f(q))] as const);
  if (kind === "line") c.polyline(xy, 2.5, color);
  else for (const [x, y] of xy) { c.disc(x, y, 5.5, C.surface); c.disc(x, y, 4, color); }
}

export function plotPolar(trimmed: readonly PolarPoint[], simulated: readonly SimPolarPoint[], s: PolarSummary, title: string): Buffer {
  const W = 1100, H = 860;
  const c = new Canvas(W, H, C.surface);
  const xMin = 50, xMax = 200;
  const maxSink = Math.ceil(Math.max(...trimmed.map((q) => q.sinkMs)));
  const maxLd = Math.ceil(Math.max(...trimmed.map((q) => q.glideRatio)) / 5) * 5;

  c.text(title, 110, 24, C.text, { size: 3 });
  // Legend (two series) with marks matching the plot.
  let lx = 110;
  const ly = 64;
  c.polyline([[lx, ly + 7], [lx + 28, ly + 7]], 2.5, C.trim);
  lx += 38 + c.text("Trimmed steady state", lx + 38, ly, C.text2);
  lx += 70;
  c.disc(lx + 6, ly + 7, 4, C.sim);
  c.text("Simulated 20 s average", lx + 20, ly, C.text2);

  const sink: Panel = { x: 110, y: 110, w: 950, h: 380, xMin, xMax, yMin: 0, yMax: maxSink, invertY: true };
  axes(c, sink, 10, 0.5, "Sink (m/s)", null, (v) => v.toFixed(1));
  series(c, sink, trimmed, (q) => q.sinkMs, C.trim, "line");
  series(c, sink, simulated, (q) => q.sinkMs, C.sim, "dots");

  const ld: Panel = { x: 110, y: 540, w: 950, h: 240, xMin, xMax, yMin: 0, yMax: maxLd };
  axes(c, ld, 10, 10, "L/D", "EAS (km/h), sea level", (v) => v.toFixed(0));
  series(c, ld, trimmed, (q) => q.glideRatio, C.trim, "line");
  series(c, ld, simulated, (q) => q.glideRatio, C.sim, "dots");

  // Selective direct labels: min sink and best glide only.
  const ann = (p: Panel, q: PolarPoint, v: number, label: string, dy: number) => {
    const x = px(p, q.easKmh), y = py(p, v);
    c.rect(x - 0.5, Math.min(y, y + dy), 1, Math.abs(dy), C.text2);
    const w = label.length * 12;
    c.rect(x + 3, y + dy - 12, w + 10, 24, C.surface);
    c.text(label, x + 8, y + dy - 7, C.text, { align: "left" });
  };
  ann(sink, s.minSink, s.minSink.sinkMs, `Min sink ${s.minSink.sinkMs.toFixed(2)} m/s @ ${s.minSink.easKmh.toFixed(0)} km/h`, 60);
  ann(ld, s.bestGlide, s.bestGlide.glideRatio, `Best L/D ${s.bestGlide.glideRatio.toFixed(1)} @ ${s.bestGlide.easKmh.toFixed(0)} km/h`, 110);
  return c.toPng();
}
