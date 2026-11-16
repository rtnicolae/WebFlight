/**
 * Light for the time of day, set once at start (the clock does not run):
 *  - day: Cesium's sun, white;
 *  - low sun: the sun's light turns orange and weakens, the sky light turns cool, the ground
 *    dims a little, clouds go warm;
 *  - night: a faint blue moonlight from high up, a dark ground, dark buildings with lit
 *    windows, dark clouds, stars.
 * Cesium does not darken the ground near the camera at night (its day/night shading fades
 * out close up), and our own shaders had a fixed daylight ambient term: at night everything
 * stayed as bright as at noon under a black sky. Everything that draws takes its light from
 * LOOK now: imagery layers through their brightness, models through their image-based
 * lighting, our shaders through the GLSL constants in lookGlsl().
 */
import { Cartesian2, Cartesian3, Color, DirectionalLight, SunLight, Transforms, type ImageryLayer, type Model, type Viewer } from "cesium";

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i]! - v) * t);

export const LOOK = {
  /** 0 night … 1 day. */
  day: 1,
  /** Sky light on surfaces, relative to full daylight (RGB). */
  ambient: [1, 1, 1],
  /** Brightness of the ground imagery and of models' environment light. */
  ground: 1,
  /** Tint of the clouds. */
  cloud: [1, 1, 1],
};

/** Derive LOOK from the sun's elevation [deg]. Call before anything is drawn. */
export function setLook(sunElevationDeg: number): void {
  const el = sunElevationDeg;
  const day = smooth(-7, 3, el), high = smooth(0, 28, el);
  LOOK.day = day;
  // Dusk sky light is cool and weaker; night is a deep blue.
  LOOK.ambient = mix3([0.07, 0.1, 0.17], mix3([0.62, 0.68, 0.86], [1, 1, 1], high), day);
  LOOK.ground = 0.16 + 0.84 * day * (0.7 + 0.3 * high);
  LOOK.cloud = mix3([0.1, 0.12, 0.18], mix3([1.0, 0.72, 0.58], [1, 1, 1], smooth(2, 20, el)), day);
}

/** GLSL constants for our shaders: replaces LOOK_AMBIENT (vec3) and LOOK_NIGHT (float). */
export function lookGlsl(src: string): string {
  const f = (v: number) => v.toFixed(4);
  return src.replaceAll("LOOK_AMBIENT", `vec3(${LOOK.ambient.map(f).join(", ")})`).replaceAll("LOOK_NIGHT", f(1 - LOOK.day));
}

/** A model's environment (image-based) light follows the time of day. */
export function lightModel(m: Model): void {
  m.imageBasedLighting.imageBasedLightingFactor = new Cartesian2(LOOK.ground, LOOK.ground);
}

export function applyLighting(viewer: Viewer, sun: { azimuthDeg: number; elevationDeg: number }, latDeg: number, lonDeg: number): void {
  const scene = viewer.scene, el = sun.elevationDeg;
  if (el > -3) {
    // The sun: orange and weak at the horizon, white from ~25° up.
    const high = smooth(0, 25, el), strength = smooth(-3, 10, el);
    const c = mix3([1, 0.56, 0.3], [1, 0.97, 0.93], high).map((v) => v * (0.25 + 0.75 * strength));
    scene.light = new SunLight({ color: new Color(c[0], c[1], c[2], 1), intensity: 2 });
  } else {
    // Moonlight: from 50° up, opposite the sun's azimuth, faint and blue.
    const az = ((sun.azimuthDeg + 180) * Math.PI) / 180, e = (50 * Math.PI) / 180;
    const toMoon = new Cartesian3(Math.sin(az) * Math.cos(e), Math.cos(az) * Math.cos(e), Math.sin(e));
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lonDeg, latDeg));
    const world = new Cartesian3(
      enu[0]! * toMoon.x + enu[4]! * toMoon.y + enu[8]! * toMoon.z,
      enu[1]! * toMoon.x + enu[5]! * toMoon.y + enu[9]! * toMoon.z,
      enu[2]! * toMoon.x + enu[6]! * toMoon.y + enu[10]! * toMoon.z,
    );
    scene.light = new DirectionalLight({ direction: Cartesian3.negate(world, new Cartesian3()), color: new Color(0.55, 0.68, 1, 1), intensity: 0.2 });
  }
  // Ground imagery (every layer, also those added later).
  const dim = (l: ImageryLayer) => {
    if ((l.imageryProvider as unknown as { selfLit?: boolean }).selfLit) return; // detail tiles darken themselves
    l.brightness = LOOK.ground;
    l.saturation = 0.45 + 0.55 * LOOK.day;
  };
  for (let i = 0; i < viewer.imageryLayers.length; i++) dim(viewer.imageryLayers.get(i));
  viewer.imageryLayers.layerAdded.addEventListener(dim);
  const b = scene.globe.baseColor;
  scene.globe.baseColor = new Color(b.red * LOOK.ground, b.green * LOOK.ground, b.blue * LOOK.ground, 1);
}
