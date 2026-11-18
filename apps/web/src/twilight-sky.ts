/**
 * The sky from just before sunset until it is dark (sun +2° … −10°).
 *
 * Cesium's sky is computed round the sun's direction, so with the sun at the horizon it draws
 * rings round it (a halo arching 50° up, its colour bands green and magenta) and with the sun
 * below the horizon nothing at all. The real twilight sky is laid out by height: a glow low
 * over the sunset (red-orange at the horizon, pale yellow above, wide in bearing), blue overhead
 * darkening with the sun, and opposite the sunset the earth's shadow under a pink band (the
 * "belt of Venus"). That is drawn here on a dome round the camera, behind the ground (depth
 * tested) and under the clouds (drawn after it); Cesium's sky is hidden meanwhile.
 *
 * Colours are display values by sun elevation, keyed at +2, 0, −3, −6, −10° and eased between,
 * chosen by eye from photographs of clear summer twilights.
 */
import { Appearance, Cartesian3, CullFace, EllipsoidGeometry, GeometryInstance, Matrix4, Primitive, Transforms, VertexFormat, type Viewer } from "cesium";

const KEYS = [2, 0, -3, -6, -10];
type C3 = [number, number, number];
const ZENITH: C3[] = [[0.3, 0.48, 0.78], [0.25, 0.4, 0.68], [0.17, 0.27, 0.5], [0.08, 0.13, 0.27], [0.025, 0.04, 0.09]];
const HORIZON: C3[] = [[0.62, 0.68, 0.78], [0.52, 0.55, 0.64], [0.33, 0.34, 0.42], [0.14, 0.15, 0.21], [0.045, 0.05, 0.075]];
/** Red-orange at the horizon under the sun, then pale yellow above it, then the blue. */
const INNER: C3[] = [[1.0, 0.62, 0.3], [1.0, 0.55, 0.25], [0.95, 0.45, 0.18], [0.62, 0.25, 0.1], [0.12, 0.05, 0.03]];
const OUTER: C3[] = [[0.98, 0.88, 0.68], [0.98, 0.85, 0.62], [0.8, 0.66, 0.48], [0.38, 0.28, 0.22], [0.06, 0.05, 0.05]];
/** How high each glow reaches (e-folding) [deg]. */
const INNER_H = [6, 4.5, 3.5, 2.5, 1.5];
const OUTER_H = [18, 14, 11, 7, 4];
const BELT: C3 = [0.64, 0.47, 0.52];
const BELT_K = [0.2, 0.35, 0.3, 0.06, 0];

/** Value at sun elevation el from keyed values (eased; held beyond the ends). */
function at<T extends number | C3>(vals: T[], el: number): T {
  if (el >= KEYS[0]!) return vals[0]!;
  for (let i = 1; i < KEYS.length; i++) {
    if (el >= KEYS[i]!) {
      const t0 = (KEYS[i - 1]! - el) / (KEYS[i - 1]! - KEYS[i]!), t = t0 * t0 * (3 - 2 * t0);
      const a = vals[i - 1]!, b = vals[i]!;
      return (typeof a === "number" ? a + ((b as number) - a) * t : (a as C3).map((v, k) => v + ((b as C3)[k]! - v) * t)) as T;
    }
  }
  return vals[vals.length - 1]!;
}

const v3 = (c: number[]) => `vec3(${c.map((x) => x.toFixed(4)).join(", ")})`;

export function twilightSkyActive(sunElevationDeg: number): boolean {
  return sunElevationDeg < 2 && sunElevationDeg > -10;
}

/** Adds the dome when the sun is in the twilight range; returns whether it did. */
/** Our own atmosphere (atmosphere.ts) draws the twilight itself: no twilight dome then. */
let ownSky = false;
export function setOwnSky(on: boolean): void {
  ownSky = on;
}

export function addTwilightSky(viewer: Viewer, sun: { azimuthDeg: number; elevationDeg: number }): boolean {
  const el = sun.elevationDeg;
  if (ownSky || !twilightSkyActive(el)) return false;
  const az = (sun.azimuthDeg * Math.PI) / 180, e = (el * Math.PI) / 180;
  const sunDir = [Math.sin(az) * Math.cos(e), Math.cos(az) * Math.cos(e), Math.sin(e)];
  const disc = el > -0.6; // the sun's disc still (partly) above the horizon
  const FS = `
in vec3 v_dir;
void main() {
  vec3 d = normalize(v_dir);
  float s = max(d.z, 0.0);
  float c = dot(normalize(d.xy + vec2(1e-6)), normalize(vec2(${sunDir[0]!.toFixed(5)}, ${sunDir[1]!.toFixed(5)})));
  vec3 col = mix(${v3(at(HORIZON, el))}, ${v3(at(ZENITH, el))}, pow(s, 0.45));
  float toward = 0.5 + 0.5 * c;
  col = mix(col, ${v3(at(OUTER, el))}, exp(-s / ${((at(OUTER_H, el) * Math.PI) / 180).toFixed(4)}) * pow(toward, 2.0));
  col = mix(col, ${v3(at(INNER, el))}, exp(-s / ${((at(INNER_H, el) * Math.PI) / 180).toFixed(4)}) * pow(toward, 3.0));
  // Opposite the sunset: the earth's shadow, then a pink band above it.
  float away = 0.5 - 0.5 * c;
  col = mix(col, ${v3(BELT)}, ${at(BELT_K, el).toFixed(4)} * exp(-abs(s - 0.06) / 0.05) * away * away);
  ${disc ? `float cs = dot(d, ${v3(sunDir)});
  col = mix(col, vec3(1.0, 0.86, 0.62), smoothstep(0.999986, 0.99999, cs));
  col += vec3(1.0, 0.7, 0.4) * 0.35 * pow(max(cs, 0.0), 600.0);` : ""}
  out_FragColor = czm_gammaCorrect(vec4(col, 1.0));
}`;
  const VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in float batchId;
out vec3 v_dir;
void main() {
  v_dir = normal; // model frame = east-north-up at the camera
  gl_Position = czm_modelViewProjectionRelativeToEye * czm_computePosition();
}`;
  // Beyond any ground in view (the far frustum), inside Cesium's far plane.
  const R = 400_000;
  const scene = viewer.scene;
  const dome = new Primitive({
    geometryInstances: new GeometryInstance({ geometry: new EllipsoidGeometry({ radii: new Cartesian3(R, R, R), vertexFormat: VertexFormat.POSITION_AND_NORMAL, stackPartitions: 96, slicePartitions: 96 }) }),
    appearance: new Appearance({ vertexShaderSource: VS, fragmentShaderSource: FS, translucent: false, closed: false, renderState: { depthTest: { enabled: true }, depthMask: false, cull: { enabled: true, face: CullFace.FRONT } } }),
    asynchronous: false,
    compressVertices: false,
    allowPicking: false,
    modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
  });
  const follow = () => {
    dome.modelMatrix = Transforms.eastNorthUpToFixedFrame(viewer.camera.positionWC, undefined, dome.modelMatrix);
  };
  follow();
  scene.preRender.addEventListener(follow);
  scene.primitives.add(dome);
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  return true;
}
