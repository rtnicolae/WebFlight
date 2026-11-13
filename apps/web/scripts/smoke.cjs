/**
 * Browser smoke test against a running dev/preview server (needs Playwright + Chromium):
 *   node apps/web/scripts/smoke.cjs [url]
 * Checks: boots, cross-origin isolated, FDM ~120 Hz, glider flies, a hands-off low
 * approach touches down without bouncing or sinking through the ground.
 */
const { chromium } = require("playwright");
const base = process.argv[2] ?? "http://localhost:5173/";

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(new URL("?agl=12&dist=500&eas=80", base).href);
  await page.waitForSelector("#boot[hidden]", { state: "attached", timeout: 90000 });
  const read = () =>
    page.evaluate(() => {
      const w = window.webflight, g = (n) => w.reader.data[w.layout.at(n)];
      return { iso: crossOriginIsolated, t: g("simulation/sim-time-sec"), agl: g("position/h-agl-ft") * 0.3048, wow: g("/gear/gear[1]/compression-norm") > 0, status: document.querySelector(".hud-status").textContent };
    });
  const samples = [];
  for (let i = 0; i < 400; i++) {
    samples.push(await read());
    if (samples.filter((s) => s.wow).length > 40) break;
    await page.waitForTimeout(100);
  }
  const td = samples.findIndex((s) => s.wow);
  const after = td >= 0 ? samples.slice(td) : [];
  const hz = Number(/FDM (\d+) Hz/.exec(samples.at(-1).status)?.[1] ?? 0);
  const result = {
    isolated: samples[0].iso,
    fdmHz: hz,
    touchedDown: td >= 0,
    wheelLeftGroundAfterTouchdown: after.filter((s) => !s.wow).length,
    minAglAfterTouchdown: Math.min(...after.map((s) => s.agl)),
    errors,
  };
  console.log(JSON.stringify(result, null, 1));
  await browser.close();
  const ok = result.isolated && hz > 110 && hz < 130 && result.touchedDown && result.wheelLeftGroundAfterTouchdown === 0 && result.minAglAfterTouchdown > 0.6 && errors.length === 0;
  process.exit(ok ? 0 : 1);
})();
