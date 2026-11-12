/** Animation manifest schema shared by the converter (writer) and the renderer (reader). */

export type Operand = { prop: string } | { value: number | string };
export type Condition =
  | { op: "and" | "or"; args: Condition[] }
  | { op: "not"; arg: Condition }
  | { op: "eq" | "ne" | "lt" | "gt" | "le" | "ge"; a: Operand; b: Operand }
  | { op: "prop"; prop: string }
  | { op: "const"; value: boolean };

export interface ValueSpec {
  property?: string;
  start: number;
  factor: number;
  offset: number;
  min?: number;
  max?: number;
  table?: [number, number][];
}

export type AnimationEntry =
  | { type: "rotate" | "spin"; nodes: string[]; value: ValueSpec; center: [number, number, number]; axis: [number, number, number]; condition?: Condition }
  | { type: "translate"; nodes: string[]; value: ValueSpec; axis: [number, number, number]; condition?: Condition }
  | { type: "select"; nodes: string[]; condition: Condition };

