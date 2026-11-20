/**
 * Browser smoke test against a running dev/preview server (needs Playwright + Chromium):
 *   node apps/web/scripts/smoke.cjs [url]
 * Checks: boots, cross-origin isolated, FDM ~120 Hz, glider flies, a hands-off low
 * approach touches down without bouncing or sinking through the ground (with shared memory
 * and with ?nosab=1, the postMessage snapshots); a winch launch (no tow plane) and an aerotow
 * start (L) pull the glider into the air and show the rope and, for aerotow, the tow plane.
 */
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://localhost:5173/";

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The runway: a ground start stands 50 m past the threshold, facing along it. (Without lat/lon
  // every start is a ground start: "?agl=12&dist=500" started on the runway and "landed" at once.
  // With no parameters at all the page is the menu.)
  await page.goto(new URL("?launch=aerotow", base).href);
  await page.waitForSelector("#boot[hidden]", { state: "attached", timeout: 90000 });
  const rwy = await page.evaluate(() => {
    const w = window.webflight, g = (n) => w.reader.data[w.layout.at(n)];
    return { lat: g("position/lat-geod-deg"), lon: g("position/long-gc-deg"), hdg: (g("attitude/psi-rad") * 180) / Math.PI };
  });
  await page.close();
  // An approach 550 m back along it, 12 m up at 80 km/h, hands off.
  const back = 550, h = (rwy.hdg * Math.PI) / 180;
  const lat = rwy.lat - (back * Math.cos(h)) / 111132, lon = rwy.lon - (back * Math.sin(h)) / (111320 * Math.cos((rwy.lat * Math.PI) / 180));
  const approach = `?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&hdg=${rwy.hdg.toFixed(1)}&agl=12&eas=80`;
  const result = { errors };
  for (const transport of ["shared", "nosab"]) {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    p.on("pageerror", (e) => errors.push(`${transport}: ${e.message}`));
    await p.goto(new URL(approach + (transport === "nosab" ? "&nosab=1" : ""), base).href);
    await p.waitForSelector("#boot[hidden]", { state: "attached", timeout: 90000 });
    const read = () =>
      p.evaluate(() => {
        const w = window.webflight, g = (n) => w.reader.data[w.layout.at(n)];
        return { iso: crossOriginIsolated, t: g("simulation/sim-time-sec"), agl: g("position/h-agl-ft") * 0.3048, wow: g("/gear/gear[1]/compression-norm") > 0, status: document.querySelector(".hud-status").textContent };
      });
    const samples = [];
    for (let i = 0; i < 400; i++) {
      samples.push(await read());
      if (samples.filter((s) => s.wow).length > 40) break;
      await p.waitForTimeout(100);
    }
    const td = samples.findIndex((s) => s.wow);
    const after = td >= 0 ? samples.slice(td) : [];
    result[transport] = {
      isolated: samples[0].iso,
      fdmHz: Number(/FDM (\d+) Hz/.exec(samples.at(-1).status)?.[1] ?? 0),
      startAglM: Math.round(samples[0].agl * 10) / 10,
      startedInAir: !samples[0].wow && samples[0].agl > 5,
      touchedDown: td > 0,
      wheelLeftGroundAfterTouchdown: after.filter((s) => !s.wow).length,
      minAglAfterTouchdown: Math.min(...after.map((s) => s.agl)),
    };
    await p.close();
  }
  // Launches: start on the runway, press L, check the rope pulls the glider into the air.
  for (const kind of ["winch", "aerotow"]) {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    p.on("pageerror", (e) => errors.push(`${kind}: ${e.message}`));
    await p.goto(new URL(`?launch=${kind}`, base).href);
    await p.waitForSelector("#boot[hidden]", { state: "attached", timeout: 90000 });
    await p.waitForTimeout(1500);
    await p.keyboard.press("KeyL");
    let maxF = 0, maxAgl = 0, rope = 0, tug = 0;
    for (let i = 0; i < (kind === "winch" ? 30 : 60); i++) {
      await p.waitForTimeout(500);
      const s = await p.evaluate(() => { const w = window.webflight, g = (n) => w.reader.data[w.layout.at(n)]; return { F: g("/sim/hitches/rope/force-N"), agl: g("position/h-agl-ft") * 0.3048, rope: g("/sim/hitches/rope/exist"), tug: g("/ai/models/dragger/valid") }; });
      maxF = Math.max(maxF, s.F); maxAgl = Math.max(maxAgl, s.agl); rope = Math.max(rope, s.rope); tug = Math.max(tug, s.tug);
    }
    result[kind] = { maxRopeForceN: Math.round(maxF), maxAglM: Math.round(maxAgl), rope, tug };
    await p.close();
  }
  console.log(JSON.stringify(result, null, 1));
  await browser.close();
  const launchesOk = result.winch.maxRopeForceN > 2000 && result.winch.maxAglM > 30 && result.winch.tug === 0 && result.aerotow.maxRopeForceN > 500 && result.aerotow.maxAglM > 5 && result.aerotow.tug === 1;
  const landed = (r) => r.startedInAir && r.fdmHz > 110 && r.fdmHz < 130 && r.touchedDown && r.wheelLeftGroundAfterTouchdown === 0 && r.minAglAfterTouchdown > 0.6;
  const ok = launchesOk && result.shared.isolated && landed(result.shared) && landed(result.nosab) && errors.length === 0;
  process.exit(ok ? 0 : 1);
})();
