/**
 * Whether temporal anti-aliasing (taa.ts) runs and which frame it is on: per-pixel noise
 * elsewhere (the clouds' march) may then change every frame, for the frames' average to
 * smooth. Its own module so the clouds need not import the TAA (and its imports).
 */
export const temporal = { on: false, frame: 0 };
