declare module "earcut" {
  /** Triangulate a flat [x0, y0, x1, y1, …] polygon; holeIndices are vertex indices where holes start. */
  export default function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number>, dim?: number): number[];
}
