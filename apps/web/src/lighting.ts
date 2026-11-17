/**
 * Light for the time of day, set once at start (the clock does not run):
 *  - day: Cesium's sun, white;
 *  - low sun: the sun's light turns orange and weakens, the sky light turns cool, the ground
 *    dims a little, clouds go warm;
 *  - twilight: our own sky (twilight-sky.ts), the light from the glow over the sunset, the
 *    ground lit by the sky (blue-grey), a dim haze (in the earth's shadow);
 *  - night: a faint blue light, a dark ground, dark buildings with lit windows, dark clouds,
 *    stars.
 * Cesium does not darken the ground near the camera at night (its day/night shading fades
 * out close up), and our own shaders had a fixed daylight ambient term: at night everything
 * stayed as bright as at noon under a black sky. Everything that draws takes its light from
 * LOOK now: the ground through a sky-light term in Cesium's ground shader, models through
 * their image-based lighting, our shaders through the GLSL constants in lookGlsl().
 */
import { Cartesian2, Cartesian3, Color, DirectionalLight, SunLight, Transforms, type ImageryLayer, type Model, type Viewer } from "cesium";
import { addTwilightSky } from "./twilight-sky.ts";

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
  /** Sky light on the ground, added to the sun's (see groundSkyLight). */
  groundSky: [0, 0, 0],
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
  LOOK.groundSky = groundSkyLight(el);
}

/** GLSL constants for our shaders: replaces LOOK_AMBIENT (vec3) and LOOK_NIGHT (float). */
export function lookGlsl(src: string): string {
  const f = (v: number) => v.toFixed(4);
  return src
    .replaceAll("LOOK_AMBIENT", `vec3(${LOOK.ambient.map(f).join(", ")})`)
    .replaceAll("LOOK_GROUND_SKY", `vec3(${LOOK.groundSky.map(f).join(", ")})`)
    .replaceAll("LOOK_NIGHT", f(1 - LOOK.day));
}

/** A model's environment (image-based) light follows the time of day. */
export function lightModel(m: Model): void {
  m.imageBasedLighting.imageBasedLightingFactor = new Cartesian2(LOOK.ground, LOOK.ground);
}

/** World direction (ECEF) of azimuth/elevation [deg] at a place. */
function worldDir(latDeg: number, lonDeg: number, azDeg: number, elDeg: number): Cartesian3 {
  const az = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
  const v = new Cartesian3(Math.sin(az) * Math.cos(e), Math.cos(az) * Math.cos(e), Math.sin(e));
  const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lonDeg, latDeg));
  return new Cartesian3(enu[0]! * v.x + enu[4]! * v.y + enu[8]! * v.z, enu[1]! * v.x + enu[5]! * v.y + enu[9]! * v.z, enu[2]! * v.x + enu[6]! * v.y + enu[10]! * v.z);
}

/**
 * Light of the sky on the ground [RGB], added to the sun's in Cesium's ground shader: after
 * sunset the sun's light is gone but the sky still lights the ground (blue-grey at civil dusk,
 * faint at night). By day the photo has the sky's light in it already.
 */
function groundSkyLight(el: number): number[] {
  const night = [0.04, 0.05, 0.08], dusk = [0.2, 0.22, 0.3];
  return mix3(night, dusk, smooth(-12, -2, el)).map((v) => v * (1 - smooth(0, 8, el)));
}


/**
 * The haze after sunset. The air near the ground is in the earth's shadow then, but Cesium
 * colours it as if lit by our light just above the horizon, with its strong forward glow:
 * the valley haze shone pink in front of mountains that should stand dark against the sunset.
 * So from sunset on the haze is a dim blue-grey, a little warmer towards the sunset.
 * k: how much of it replaces Cesium's haze colour.
 */
function twilightHaze(el: number): { base: number[]; sun: number[]; k: number } {
  const base = mix3([0.03, 0.035, 0.05], [0.21, 0.23, 0.3], smooth(-12, -2, el));
  const sun = [0.26, 0.15, 0.09].map((v) => v * smooth(-10, -1, el));
  return { base, sun, k: 1 - smooth(-4, 2, el) };
}

const vec3 = (v: number[]) => `vec3(${v.map((x) => x.toFixed(4)).join(", ")})`;

/** Cesium's ground shader lights the photo only with the scene's light: add the sky's, and set the haze after sunset. */
function patchGround(scene: Viewer["scene"], sky: number[], haze: { base: number[]; sun: number[]; k: number }): void {
  type Internals = { _surfaceShaderSet?: { baseFragmentShaderSource?: { sources: string[] } } };
  const globe = scene.globe as unknown as Internals;
  const LIGHT = "vec4 finalColor = vec4(color.rgb * czm_lightColor * diffuseIntensity, color.a);";
  const FOG = "finalColor = vec4(czm_fog(v_distance, finalColor.rgb, fogColor.rgb, czm_fogVisualDensityScalar), finalColor.a);";
  const light = `vec4 finalColor = vec4(color.rgb * (czm_lightColor * diffuseIntensity + ${vec3(sky)}), color.a);`;
  const fog =
    haze.k > 0
      ? `fogColor.rgb = mix(fogColor.rgb, ${vec3(haze.base)} + ${vec3(haze.sun)} * pow(max(dot(normalize(v_positionEC), czm_lightDirectionEC), 0.0), 6.0), ${haze.k.toFixed(4)});\n            ${FOG}`
      : FOG;
  const patch = () => {
    const src = globe._surfaceShaderSet?.baseFragmentShaderSource;
    if (!src) return;
    src.sources = src.sources.map((s) => (s.includes(LIGHT) || s.includes(FOG) ? s.replaceAll(LIGHT, light).replace(FOG, fog) : s));
  };
  patch();
  // Cesium rebuilds the base source when the globe's setup changes: patch again before drawing.
  let last = globe._surfaceShaderSet?.baseFragmentShaderSource;
  scene.preRender.addEventListener(() => {
    const now = globe._surfaceShaderSet?.baseFragmentShaderSource;
    if (now !== last) (last = now), patch();
  });
}

export function applyLighting(viewer: Viewer, sun: { azimuthDeg: number; elevationDeg: number }, latDeg: number, lonDeg: number): void {
  const scene = viewer.scene, el = sun.elevationDeg;
  // Cesium's sky and haze take their light from the scene's light (not the sun). Below 5° the
  // light comes from the sun's bearing but no lower than just above the horizon (from the
  // glow over the sunset, after sunset), its colour turning to the sky's.
  scene.globe.dynamicAtmosphereLightingFromSun = false;
  if (el >= 5) {
    // The sun: white from ~25° up, warmer below.
    const high = smooth(0, 25, el), strength = smooth(-3, 10, el);
    const c = mix3([1, 0.56, 0.3], [1, 0.97, 0.93], high).map((v) => v * (0.25 + 0.75 * strength));
    scene.light = new SunLight({ color: new Color(c[0], c[1], c[2], 1), intensity: 2 });
  } else {
    const liftedEl = Math.max(1.2, 5 + (el - 5) * 0.4);
    let c: number[], k: number;
    if (el > -3) {
      // The setting sun: orange and weak.
      const strength = smooth(-3, 10, el);
      c = mix3([1, 0.56, 0.3], [1, 0.97, 0.93], smooth(0, 25, el));
      k = 0.25 + 0.75 * strength;
    } else {
      // Twilight, then night: the sky's light, lavender fading to a faint blue.
      const t = smooth(-12, -2, el);
      c = mix3([0.5, 0.62, 0.95], [0.66, 0.68, 0.9], t);
      k = 0.22 + 0.33 * t;
    }
    scene.light = new DirectionalLight({ direction: Cartesian3.negate(worldDir(latDeg, lonDeg, sun.azimuthDeg, liftedEl), new Cartesian3()), color: new Color(c[0]! * k, c[1]! * k, c[2]! * k, 1), intensity: 1 });
    // From +2° to −10° our own twilight sky (twilight-sky.ts); after that Cesium's, darkened.
    if (!addTwilightSky(viewer, sun)) {
      if (scene.skyAtmosphere) scene.skyAtmosphere.brightnessShift = 0.04 - 0.75 * (1 - smooth(-14, 0, el));
      // Stars once it is dark enough to see them.
      if (scene.skyBox) scene.skyBox.show = el < -10;
    }
  }
  patchGround(scene, LOOK.groundSky, twilightHaze(el));
  // Ground imagery (every layer, also those added later): its light comes from the ground
  // shader (sun plus sky above); only the colour fades at night.
  const dim = (l: ImageryLayer) => {
    if ((l.imageryProvider as unknown as { selfLit?: boolean }).selfLit) return; // detail tiles darken themselves
    l.saturation = 0.45 + 0.55 * LOOK.day;
  };
  for (let i = 0; i < viewer.imageryLayers.length; i++) dim(viewer.imageryLayers.get(i));
  viewer.imageryLayers.layerAdded.addEventListener(dim);
  const b = scene.globe.baseColor;
  scene.globe.baseColor = new Color(b.red * LOOK.ground, b.green * LOOK.ground, b.blue * LOOK.ground, 1);
}
