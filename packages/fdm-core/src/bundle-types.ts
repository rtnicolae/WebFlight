/** Animation manifest schema shared by the converter (writer) and the renderer (reader). */

export type Operand = { prop: string } | { value: number | string };
export type Condition =
  | { op: "and" | "or"; args: Condition[] }
  | { op: "not"; arg: Condition }
  | { op: "eq" | "ne" | "lt" | "gt" | "le" | "ge"; a: Operand; b: Operand }
  | { op: "prop"; prop: string }
  | { op: "const"; value: boolean };

/** PropertyList XML as JSON (converter output): ordered children, index, value, type, alias. */
export interface PNode {
  n: string;
  i: number;
  v?: string;
  t?: string;
  a?: string;
  c?: PNode[];
}

export interface ValueSpec {
  /** SGExpression element (e.g. <sum>); when present the other fields are ignored. */
  expr?: PNode;
  /** Texture animations: added before stepping (SGBiasExpression). */
  bias?: number;
  /** Texture animations: SGStepExpression step and odometer-like scroll. */
  step?: number;
  scroll?: number;
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
  | { type: "select"; nodes: string[]; condition: Condition }
  /** textranslate / texrotate / texmultiple; transforms in FG texture space (v up), in order. */
  | { type: "tex"; nodes: string[]; transforms: TexTransform[]; condition?: Condition }
  /** pick / knob / slider: clickable objects. Bindings are FG <binding> PropertyLists. */
  | { type: "pick"; nodes: string[]; kind: "pick" | "knob" | "slider" | "touch"; action?: PNode; increase?: PNode; decrease?: PNode; drag?: "vertical" | "horizontal"; tooltip?: string };

export type TexTransform =
  | { kind: "translate"; axis: [number, number]; value: ValueSpec }
  | { kind: "rotate"; center: [number, number]; value: ValueSpec };

