/** OpenFreeMap (OpenStreetMap in the OpenMapTiles schema; free, no key): the versioned tile URL. */
const OPENFREEMAP = "https://tiles.openfreemap.org/planet";

let tiles: Promise<string | undefined> | undefined;
export function openFreeMapTiles(): Promise<string | undefined> {
  tiles ??= fetch(OPENFREEMAP)
    .then((r) => r.json() as Promise<{ tiles?: string[] }>)
    .then((tj) => tj.tiles?.[0])
    .catch(() => undefined);
  return tiles;
}
