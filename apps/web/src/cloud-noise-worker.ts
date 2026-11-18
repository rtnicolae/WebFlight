/** Makes the clouds' noise textures off the main thread (cloud-noise.ts). */
import { cloudNoise } from "./cloud-noise.ts";

const n = cloudNoise();
(self as unknown as Worker).postMessage(n, [n.shape.buffer, n.detail.buffer]);
