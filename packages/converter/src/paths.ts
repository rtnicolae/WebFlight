import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives at packages/converter/src/paths.ts). */
export const repoRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Local, git-ignored cache for FGAddon downloads. Override with WEBFLIGHT_FGADDON_CACHE. */
export const defaultCacheDir = (): string =>
  process.env["WEBFLIGHT_FGADDON_CACHE"] ?? path.join(repoRoot(), ".cache", "fgaddon");
