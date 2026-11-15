// Available in browsers, workers and Node; declared here because the package uses "types": [].
declare class TextDecoder {
  constructor(label?: string);
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
