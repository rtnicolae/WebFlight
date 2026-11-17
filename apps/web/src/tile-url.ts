/**
 * A Web Mercator photo tile's URL from a template: {quadkey} (Bing) or {z}/{x}/{y} (Esri,
 * Google). Shared by the workers that read the aerial photo's pixels (roof colours, grass,
 * alignment), whichever source the ground shows.
 */
export function tileUrl(template: string, x: number, y: number, z: number): string {
  if (template.includes("{quadkey}")) {
    let k = "";
    for (let i = z; i > 0; i--) {
      const m = 1 << (i - 1);
      k += String((x & m ? 1 : 0) + (y & m ? 2 : 0));
    }
    return template.replace("{quadkey}", k);
  }
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}
