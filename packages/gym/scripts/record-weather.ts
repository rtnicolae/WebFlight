/**
 * Records weather snapshots for the gym: for N random (airfield, day, hour) draws (seeded),
 * fetches that hour's weather from Open-Meteo (forecast for the last 90 days, historical
 * reanalysis before) and writes data/weather-snapshots.json. Days: May–September of the
 * last ten years; hours 09:00–18:00 local. Snapshots that fell back to the estimate are
 * dropped.
 *   NODE_USE_ENV_PROXY=1 npx tsx packages/gym/scripts/record-weather.ts [count=500] [seed=1]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mulberry32, weatherFor, type Weather } from "@webflight/environment";
import { loadGymAirfields } from "../src/sites.ts";

const count = Number(process.argv[2] ?? 500);
const rand = mulberry32(Number(process.argv[3] ?? 1));
const fields = await loadGymAirfields();
const now = new Date();
const out: { ident: string; weather: Weather }[] = [];
for (let i = 0; i < count; i++) {
  const f = fields[Math.floor(rand() * fields.length)]!;
  const year = now.getUTCFullYear() - 1 - Math.floor(rand() * 10);
  const day = new Date(Date.UTC(year, 4, 1) + Math.floor(rand() * 153) * 86400_000).toISOString().slice(0, 10);
  const hm = `${String(9 + Math.floor(rand() * 10)).padStart(2, "0")}:${rand() < 0.5 ? "00" : "30"}`;
  const { weather } = await weatherFor(f.latDeg, f.lonDeg, { kind: "local", date: day, hm }, f.elevM, now);
  if (weather.source === "estimated") {
    console.warn(`${f.ident} ${day} ${hm}: no data (offline?)`);
    continue;
  }
  out.push({ ident: f.ident, weather });
  if (out.length % 25 === 0) console.log(`${out.length} snapshots`);
}
const file = new URL("../data/weather-snapshots.json", import.meta.url);
mkdirSync(new URL(".", file), { recursive: true });
writeFileSync(file, JSON.stringify({ source: "Open-Meteo (CC BY 4.0), recorded " + now.toISOString().slice(0, 10), snapshots: out }));
console.log(`${out.length} snapshots → ${file.pathname}`);
