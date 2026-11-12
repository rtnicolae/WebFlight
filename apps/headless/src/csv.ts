/** Write rows as CSV; columns map header -> value getter. */
export function toCsv<T>(rows: readonly T[], columns: Record<string, (r: T) => number | string>, digits = 4): string {
  const heads = Object.keys(columns);
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isFinite(v) ? Number(v.toFixed(digits)).toString() : "") : v);
  return [heads.join(","), ...rows.map((r) => heads.map((h) => fmt(columns[h]!(r))).join(","))].join("\n") + "\n";
}
