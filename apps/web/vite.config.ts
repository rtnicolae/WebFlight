import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const cesiumDir = path.join(path.dirname(require.resolve("cesium/package.json")), "Build/Cesium");
// fdm-core depends on @0x62/jsbsim-wasm; resolve its exported .wasm from there.
const fdmCoreDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../packages/fdm-core");
const jsbsimWasmDir = path.dirname(createRequire(path.join(fdmCoreDir, "package.json")).resolve("@0x62/jsbsim-wasm/wasm/binary"));

const MIME: Record<string, string> = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".xml": "application/xml",
  ".glb": "model/gltf-binary", ".html": "text/html", ".ktx2": "image/ktx2",
};

// Cross-origin isolation enables SharedArrayBuffer for the FDM snapshot. "credentialless"
// still allows loading public map tiles without CORP headers.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

/**
 * Serve directories from node_modules untouched (no Vite transforms) in dev, and copy
 * them into the build. Used for Cesium's runtime assets and the JSBSim Emscripten module
 * (which contains a Node-only dynamic import that must not be processed).
 */
function rawStatic(mounts: Record<string, string>): Plugin {
  return {
    name: "webflight-raw-static",
    configureServer(server) {
      for (const [prefix, dir] of Object.entries(mounts)) {
        server.middlewares.use(prefix, (req, res, next) => {
          const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!);
          const file = path.join(dir, rel);
          if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
          res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
          res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          // Worker scripts in an isolated page must carry COEP themselves.
          for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v);
          fs.createReadStream(file).pipe(res);
        });
      }
    },
    writeBundle(opts) {
      const out = opts.dir ?? "dist";
      for (const [prefix, dir] of Object.entries(mounts)) fs.cpSync(dir, path.join(out, prefix), { recursive: true });
    },
  };
}

export default defineConfig({
  // Aircraft bundles (pnpm bundle:ask21) are generated, GPL-licensed data: served from
// apps/web/bundles, never committed.
  plugins: [rawStatic({ "/cesium": cesiumDir, "/jsbsim": jsbsimWasmDir, "/bundles": path.resolve(path.dirname(new URL(import.meta.url).pathname), "bundles") })],
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation, port: 4173 },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@0x62/jsbsim-wasm"] },
  build: { target: "es2022", chunkSizeWarningLimit: 6000 },
});
