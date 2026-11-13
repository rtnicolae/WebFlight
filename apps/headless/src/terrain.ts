/** Terrarium terrain for Node, with tiles cached on disk under .cache/terrain. */
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "@webflight/converter";
import { fetchTerrariumTile, TerrariumTerrain } from "@webflight/environment";

export function nodeTerrain(zoom = 13): TerrariumTerrain {
  const dir = path.join(repoRoot(), ".cache", "terrain");
  return new TerrariumTerrain({
    zoom,
    fetchTile: async (z, x, y) => {
      const file = path.join(dir, String(z), String(x), `${y}.png`);
      if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file));
      const data = await fetchTerrariumTile(z, x, y);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      return data;
    },
  });
}
