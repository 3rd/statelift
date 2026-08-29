import {
  COLLECTION_BRAND,
  getSnapshotRawOrigin,
  isMaterializedSnapshotNode,
  opaqueObjectName,
  opaqueObjectType,
} from "./proxy";
declare const DEHYDRATED_STATE: unique symbol;
const decodedTransportNodes = new WeakSet<object>();

/** Opaque JSON-safe graph payload produced by dehydrate(). */
export type Dehydrated<T extends {}> = {
  readonly [DEHYDRATED_STATE]: (state: T) => T;
} & string;

type WireSymbol = ["global" | "well-known", string];
type WireKey = ["string", string] | ["symbol", WireSymbol];
type WireNumber = ["number", "nan" | "negative-infinity" | "negative-zero" | "positive-infinity"] | number;
type WireValue =
  | WireNumber
  | ["bigint", string]
  | ["ref", number]
  | ["symbol", WireSymbol]
  | ["undefined"]
  | boolean
  | string
  | null;
type WireProperty = [WireKey, 0 | 1, WireValue];
type WireNode =
  | ["array-buffer", number[]]
  | ["array", number, 0 | 1, WireProperty[]]
  | ["date", WireValue]
  | ["map", 0 | 1, [WireValue, WireValue][]]
  | ["object", 0 | 1, 0 | 1, WireProperty[]]
  | ["regexp", string, string, WireNumber]
  | ["set", 0 | 1, WireValue[]]
  | ["url-search-params", string]
  | ["url", string]
  | ["view", string, WireValue, number, number];

export type TransportEnvelope = {
  format: "statelift";
  version: 1;
  root: WireValue;
  nodes: WireNode[];
};

export const isDecodedTransportNode = (value: object): boolean => decodedTransportNodes.has(value);

const TRANSPORT_PREFIX = "statelift:1:";

const wellKnownSymbols = new Map<symbol, string>();
const wellKnownSymbolsByName = new Map<string, symbol>();
for (const name of Object.getOwnPropertyNames(Symbol)) {
  const value = Reflect.get(Symbol, name);
  if (typeof value !== "symbol") continue;
  wellKnownSymbols.set(value, name);
  wellKnownSymbolsByName.set(name, value);
}

const describePath = (path: string, detail: string): never => {
  throw new TypeError(`statelift: cannot serialize ${detail} at ${path}`);
};

const encodeNumber = (value: number): WireNumber => {
  if (Number.isNaN(value)) return ["number", "nan"];
  if (value === Infinity) return ["number", "positive-infinity"];
  if (value === -Infinity) return ["number", "negative-infinity"];
  if (Object.is(value, -0)) return ["number", "negative-zero"];
  return value;
};

const encodeSymbol = (value: symbol, path: string): WireSymbol => {
  const wellKnownName = wellKnownSymbols.get(value);
  if (wellKnownName !== undefined) return ["well-known", wellKnownName];
  const globalKey = Symbol.keyFor(value);
  if (globalKey !== undefined) return ["global", globalKey];
  return describePath(path, "a local symbol");
};

const encodeKey = (key: string | symbol, path: string): WireKey =>
  typeof key === "string" ? ["string", key] : ["symbol", encodeSymbol(key, path)];

const isArrayBufferValue = (value: unknown): value is ArrayBuffer =>
  typeof value === "object" && value !== null && opaqueObjectType(value) === "ArrayBuffer";

const assertNoCustomProperties = (value: object, allowed: ReadonlySet<string | symbol>, path: string) => {
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.has(key)) describePath(`${path}.${String(key)}`, "a custom built-in property");
  }
};

const containsStateCode = (value: unknown, visited: WeakSet<object> = new WeakSet()): boolean => {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;
  const current = getSnapshotRawOrigin(value) ?? value;
  if (visited.has(current)) return false;
  visited.add(current);

  const objectName = opaqueObjectType(current);
  if (objectName === "Map") {
    for (const [key, entryValue] of Map.prototype.entries.call(current)) {
      if (containsStateCode(key, visited) || containsStateCode(entryValue, visited)) return true;
    }
    return false;
  }
  if (objectName === "Set") {
    for (const entryValue of Set.prototype.values.call(current)) {
      if (containsStateCode(entryValue, visited)) return true;
    }
    return false;
  }
  if (objectName !== null) return false;

  for (const key of Reflect.ownKeys(current)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) return true;
    if (containsStateCode(descriptor.value, visited)) return true;
  }
  return false;
};

export const transportRequiresLocalSnapshot = (value: unknown): boolean => {
  const visited = new WeakSet<object>();
  const inspect = (current: unknown): boolean => {
    if (typeof current !== "object" || current === null || visited.has(current)) return false;
    visited.add(current);

    const objectName = opaqueObjectType(current);
    if (objectName === "Map") {
      const reactive = Reflect.getOwnPropertyDescriptor(current, COLLECTION_BRAND)?.value === "map";
      for (const [key, entryValue] of Map.prototype.entries.call(current)) {
        if (reactive && (containsStateCode(key) || containsStateCode(entryValue))) return true;
        if (inspect(key) || inspect(entryValue)) return true;
      }
      return false;
    }
    if (objectName === "Set") {
      const reactive = Reflect.getOwnPropertyDescriptor(current, COLLECTION_BRAND)?.value === "set";
      for (const entryValue of Set.prototype.values.call(current)) {
        if (reactive && containsStateCode(entryValue)) return true;
        if (inspect(entryValue)) return true;
      }
      return false;
    }
    if (objectName !== null) return false;
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, "value") && inspect(descriptor.value)) {
        return true;
      }
    }
    return false;
  };
  return inspect(value);
};

const assertSupportedPrototype = (value: object, path: string) => {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype === null) return;
  const objectName = Array.isArray(value) ? "Array" : opaqueObjectName(value);
  const constructor = Reflect.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  const isPlainObjectPrototype =
    typeof constructor === "function" &&
    constructor.name === "Object" &&
    Reflect.getPrototypeOf(prototype) === null;
  if (
    isPlainObjectPrototype ||
    (typeof constructor === "function" && constructor.name === objectName && objectName !== "Object")
  ) {
    return;
  }
  const typeName = typeof constructor === "function" && constructor.name ? constructor.name : objectName;
  describePath(path, `an unsupported class instance (${typeName})`);
};

type DevtoolsEncodeMetadata = {
  hasOwnStateCode: boolean[];
  childRefs: number[][];
};

const originHasStateCode = (origin: object) => {
  for (const key of Reflect.ownKeys(origin)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(origin, key);
    if (descriptor === undefined) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) return true;
    if (typeof descriptor.value === "function") return true;
  }
  return false;
};

const encodeGraph = (value: unknown, metadata?: DevtoolsEncodeMetadata): TransportEnvelope => {
  const nodes: WireNode[] = [];
  const references = new WeakMap<object, number>();

  const recordChildRef = (id: number, wire: WireValue) => {
    if (metadata === undefined || !Array.isArray(wire) || wire[0] !== "ref") return;
    const ref = wire[1];
    const refs = metadata.childRefs[id];
    if (typeof ref === "number" && refs !== undefined) refs.push(ref);
  };

  const encodeProperties = (
    object: object,
    path: string,
    skip: ReadonlySet<string | symbol>,
    id: number,
    encode: (current: unknown, path: string) => WireValue,
  ): WireProperty[] => {
    const properties: WireProperty[] = [];
    for (const key of Reflect.ownKeys(object)) {
      if (skip.has(key)) continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined) continue;
      const propertyPath = `${path}.${String(key)}`;
      const propertyValue = Reflect.get(object, key);
      // encode the key before its value so a local-symbol key is the first reported error
      const wireKey = encodeKey(key, propertyPath);
      const wire = encode(propertyValue, propertyPath);
      recordChildRef(id, wire);
      properties.push([wireKey, descriptor.enumerable === true ? 1 : 0, wire]);
    }
    return properties;
  };

  const encodeMap = (
    current: object,
    path: string,
    id: number,
    encode: (current: unknown, path: string) => WireValue,
  ): WireValue => {
    const brand = Reflect.getOwnPropertyDescriptor(current, COLLECTION_BRAND)?.value === "map" ? 1 : 0;
    const allowed = new Set<string | symbol>();
    if (brand === 1) {
      allowed.add(COLLECTION_BRAND);
      allowed.add("set");
      allowed.add("delete");
      allowed.add("clear");
    }
    assertNoCustomProperties(current, allowed, path);
    const entries: [WireValue, WireValue][] = [];
    let index = 0;
    for (const [key, entryValue] of Map.prototype.entries.call(current)) {
      const wireKey = encode(key, `${path}.<map-key:${index}>`);
      const wireEntryValue = encode(entryValue, `${path}.<map-value:${index}>`);
      recordChildRef(id, wireKey);
      recordChildRef(id, wireEntryValue);
      entries.push([wireKey, wireEntryValue]);
      index++;
    }
    nodes[id] = ["map", brand, entries];
    return ["ref", id];
  };

  const encodeSet = (
    current: object,
    path: string,
    id: number,
    encode: (current: unknown, path: string) => WireValue,
  ): WireValue => {
    const brand = Reflect.getOwnPropertyDescriptor(current, COLLECTION_BRAND)?.value === "set" ? 1 : 0;
    const allowed = new Set<string | symbol>();
    if (brand === 1) {
      allowed.add(COLLECTION_BRAND);
      allowed.add("add");
      allowed.add("delete");
      allowed.add("clear");
    }
    assertNoCustomProperties(current, allowed, path);
    const values: WireValue[] = [];
    let index = 0;
    for (const entryValue of Set.prototype.values.call(current)) {
      const wireEntryValue = encode(entryValue, `${path}.<set-value:${index}>`);
      recordChildRef(id, wireEntryValue);
      values.push(wireEntryValue);
      index++;
    }
    nodes[id] = ["set", brand, values];
    return ["ref", id];
  };

  const encodeArrayBufferView = (
    current: ArrayBufferView,
    objectName: string,
    path: string,
    id: number,
    encode: (current: unknown, path: string) => WireValue,
  ): WireValue => {
    const allowed = new Set<string | symbol>();
    for (const key of Reflect.ownKeys(current)) {
      if (
        typeof key === "string" &&
        key !== "" &&
        Number.isInteger(Number(key)) &&
        Number(key) >= 0 &&
        String(Number(key)) === key
      ) {
        allowed.add(key);
      }
    }
    assertNoCustomProperties(current, allowed, path);
    const wireBuffer = encode(current.buffer, `${path}.buffer`);
    recordChildRef(id, wireBuffer);
    nodes[id] = ["view", objectName, wireBuffer, current.byteOffset, current.byteLength];
    return ["ref", id];
  };

  const encodeBuiltIn = (
    current: object,
    objectName: string,
    path: string,
    id: number,
    encode: (current: unknown, path: string) => WireValue,
  ): WireValue | undefined => {
    switch (objectName) {
      case "Map": {
        return encodeMap(current, path, id, encode);
      }
      case "Set": {
        return encodeSet(current, path, id, encode);
      }
      case "Date": {
        assertNoCustomProperties(current, new Set(), path);
        nodes[id] = ["date", encode(Date.prototype.getTime.call(current), `${path}.<date>`)];
        return ["ref", id];
      }
      case "RegExp": {
        assertNoCustomProperties(current, new Set(["lastIndex"]), path);
        const source = Reflect.get(current, "source");
        const flags = Reflect.get(current, "flags");
        const lastIndex = Reflect.get(current, "lastIndex");
        if (typeof source !== "string" || typeof flags !== "string" || typeof lastIndex !== "number") {
          return describePath(path, "an invalid RegExp");
        }
        nodes[id] = ["regexp", source, flags, encodeNumber(lastIndex)];
        return ["ref", id];
      }
      case "ArrayBuffer": {
        if (!isArrayBufferValue(current)) return undefined;
        assertNoCustomProperties(current, new Set(), path);
        nodes[id] = ["array-buffer", [...new Uint8Array(current)]];
        return ["ref", id];
      }
      case "URL": {
        assertNoCustomProperties(current, new Set(), path);
        const href = Reflect.get(current, "href");
        if (typeof href !== "string") return describePath(path, "an invalid URL");
        nodes[id] = ["url", href];
        return ["ref", id];
      }
      case "URLSearchParams": {
        assertNoCustomProperties(current, new Set(), path);
        nodes[id] = ["url-search-params", URLSearchParams.prototype.toString.call(current)];
        return ["ref", id];
      }
      case "WeakMap":
      case "WeakSet":
      case "Promise": {
        return describePath(path, objectName);
      }
      default: {
        return undefined;
      }
    }
  };

  const encodeValue = (current: unknown, path: string): WireValue => {
    if (current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (current === undefined) return ["undefined"];
    if (typeof current === "number") return encodeNumber(current);
    if (typeof current === "bigint") return ["bigint", current.toString()];
    if (typeof current === "symbol") return ["symbol", encodeSymbol(current, path)];
    if (typeof current === "function") return describePath(path, "a function");

    const identity = getSnapshotRawOrigin(current) ?? current;
    assertSupportedPrototype(identity, path);
    const existing = references.get(identity);
    if (existing !== undefined) return ["ref", existing];
    const id = nodes.length;
    references.set(identity, id);
    nodes.push(["object", 0, 0, []]);
    if (metadata !== undefined) {
      metadata.hasOwnStateCode[id] = false;
      metadata.childRefs[id] = [];
    }

    if (Array.isArray(current)) {
      if (metadata !== undefined) {
        metadata.hasOwnStateCode[id] = originHasStateCode(identity);
      }
      const frozen = Object.isFrozen(current) && !isMaterializedSnapshotNode(current) ? 1 : 0;
      nodes[id] = [
        "array",
        current.length,
        frozen,
        encodeProperties(current, path, new Set(["length"]), id, encodeValue),
      ];
      return ["ref", id];
    }

    const objectName = opaqueObjectType(current);
    if (objectName !== null) {
      const encodedBuiltIn = encodeBuiltIn(current, objectName, path, id, encodeValue);
      if (encodedBuiltIn !== undefined) return encodedBuiltIn;
    }
    if (ArrayBuffer.isView(current)) {
      return encodeArrayBufferView(current, opaqueObjectName(current), path, id, encodeValue);
    }

    const prototype = Reflect.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      return describePath(path, `unsupported object type ${opaqueObjectName(current)}`);
    }
    if (metadata !== undefined) {
      metadata.hasOwnStateCode[id] = originHasStateCode(identity);
    }
    const frozen = Object.isFrozen(current) && !isMaterializedSnapshotNode(current) ? 1 : 0;
    nodes[id] = [
      "object",
      prototype === null ? 1 : 0,
      frozen,
      encodeProperties(current, path, new Set(), id, encodeValue),
    ];
    return ["ref", id];
  };

  return { format: "statelift", version: 1, root: encodeValue(value, "$"), nodes };
};

const isFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isWireNumber = (value: unknown): value is WireNumber =>
  (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) ||
  (Array.isArray(value) &&
    value.length === 2 &&
    value[0] === "number" &&
    (value[1] === "nan" ||
      value[1] === "positive-infinity" ||
      value[1] === "negative-infinity" ||
      value[1] === "negative-zero"));

const isWireSymbol = (value: unknown): value is WireSymbol =>
  Array.isArray(value) &&
  value.length === 2 &&
  (value[0] === "global" || value[0] === "well-known") &&
  typeof value[1] === "string";

const isWireKey = (value: unknown): value is WireKey =>
  Array.isArray(value) &&
  value.length === 2 &&
  ((value[0] === "string" && typeof value[1] === "string") ||
    (value[0] === "symbol" && isWireSymbol(value[1])));

const isWireValue = (value: unknown): value is WireValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (isWireNumber(value)) return true;
  if (!Array.isArray(value)) return false;
  if (value.length === 1) return value[0] === "undefined";
  if (value.length === 2 && value[0] === "ref") return isNonNegativeInteger(value[1]);
  if (value.length === 2 && value[0] === "bigint") {
    return typeof value[1] === "string" && /^-?\d+$/.test(value[1]);
  }
  if (value.length === 2 && value[0] === "symbol") return isWireSymbol(value[1]);
  return false;
};

const isWireProperty = (value: unknown): value is WireProperty =>
  Array.isArray(value) &&
  value.length === 3 &&
  isWireKey(value[0]) &&
  isFlag(value[1]) &&
  isWireValue(value[2]);

const isWireProperties = (value: unknown): value is WireProperty[] =>
  Array.isArray(value) && value.every(isWireProperty);

const isWireMapEntries = (value: unknown): value is [WireValue, WireValue][] =>
  Array.isArray(value) &&
  value.every(
    (entry) => Array.isArray(entry) && entry.length === 2 && isWireValue(entry[0]) && isWireValue(entry[1]),
  );

const isWireValues = (value: unknown): value is WireValue[] =>
  Array.isArray(value) && value.every(isWireValue);

const isByteArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every((byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255);

const isWireNode = (value: unknown): value is WireNode => {
  if (!Array.isArray(value) || typeof value[0] !== "string") return false;
  switch (value[0]) {
    case "object": {
      return value.length === 4 && isFlag(value[1]) && isFlag(value[2]) && isWireProperties(value[3]);
    }
    case "array": {
      return (
        value.length === 4 && isNonNegativeInteger(value[1]) && isFlag(value[2]) && isWireProperties(value[3])
      );
    }
    case "map": {
      return value.length === 3 && isFlag(value[1]) && isWireMapEntries(value[2]);
    }
    case "set": {
      return value.length === 3 && isFlag(value[1]) && isWireValues(value[2]);
    }
    case "date": {
      return value.length === 2 && isWireValue(value[1]);
    }
    case "regexp": {
      return (
        value.length === 4 &&
        typeof value[1] === "string" &&
        typeof value[2] === "string" &&
        isWireNumber(value[3])
      );
    }
    case "array-buffer": {
      return value.length === 2 && isByteArray(value[1]);
    }
    case "view": {
      return (
        value.length === 5 &&
        typeof value[1] === "string" &&
        isWireValue(value[2]) &&
        isNonNegativeInteger(value[3]) &&
        isNonNegativeInteger(value[4])
      );
    }
    case "url":
    case "url-search-params": {
      return value.length === 2 && typeof value[1] === "string";
    }
    default: {
      return false;
    }
  }
};

const isTransportEnvelope = (value: unknown): value is TransportEnvelope => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const format = Reflect.get(value, "format");
  const version = Reflect.get(value, "version");
  const root = Reflect.get(value, "root");
  const nodes = Reflect.get(value, "nodes");
  return (
    format === "statelift" &&
    version === 1 &&
    isWireValue(root) &&
    Array.isArray(nodes) &&
    nodes.every(isWireNode)
  );
};

const decodeSymbol = (value: WireSymbol) => {
  if (value[0] === "global") return Symbol.for(value[1]);
  const symbol = wellKnownSymbolsByName.get(value[1]);
  if (symbol === undefined) throw new TypeError(`statelift: unknown well-known symbol "${value[1]}"`);
  return symbol;
};

const decodeKey = (value: WireKey) => (value[0] === "string" ? value[1] : decodeSymbol(value[1]));

const viewFromBuffer = (
  name: string,
  buffer: ArrayBuffer,
  byteOffset: number,
  byteLength: number,
): ArrayBufferView => {
  if (byteOffset + byteLength > buffer.byteLength) {
    throw new TypeError("statelift: dehydrated typed-array view exceeds its ArrayBuffer bounds");
  }
  const length = (bytesPerElement: number) => {
    if (byteOffset % bytesPerElement !== 0 || byteLength % bytesPerElement !== 0) {
      throw new TypeError(`statelift: dehydrated ${name} view has invalid byte alignment`);
    }
    return byteLength / bytesPerElement;
  };
  switch (name) {
    case "DataView": {
      return new DataView(buffer, byteOffset, byteLength);
    }
    case "Int8Array": {
      return new Int8Array(buffer, byteOffset, length(Int8Array.BYTES_PER_ELEMENT));
    }
    case "Uint8Array": {
      return new Uint8Array(buffer, byteOffset, length(Uint8Array.BYTES_PER_ELEMENT));
    }
    case "Uint8ClampedArray": {
      return new Uint8ClampedArray(buffer, byteOffset, length(Uint8ClampedArray.BYTES_PER_ELEMENT));
    }
    case "Int16Array": {
      return new Int16Array(buffer, byteOffset, length(Int16Array.BYTES_PER_ELEMENT));
    }
    case "Uint16Array": {
      return new Uint16Array(buffer, byteOffset, length(Uint16Array.BYTES_PER_ELEMENT));
    }
    case "Int32Array": {
      return new Int32Array(buffer, byteOffset, length(Int32Array.BYTES_PER_ELEMENT));
    }
    case "Uint32Array": {
      return new Uint32Array(buffer, byteOffset, length(Uint32Array.BYTES_PER_ELEMENT));
    }
    case "Float32Array": {
      return new Float32Array(buffer, byteOffset, length(Float32Array.BYTES_PER_ELEMENT));
    }
    case "Float64Array": {
      return new Float64Array(buffer, byteOffset, length(Float64Array.BYTES_PER_ELEMENT));
    }
    case "BigInt64Array": {
      return new BigInt64Array(buffer, byteOffset, length(BigInt64Array.BYTES_PER_ELEMENT));
    }
    case "BigUint64Array": {
      return new BigUint64Array(buffer, byteOffset, length(BigUint64Array.BYTES_PER_ELEMENT));
    }
    default: {
      throw new TypeError(`statelift: dehydrated payload uses unsupported typed-array view "${name}"`);
    }
  }
};

const malformedPayloadError = (cause?: unknown) =>
  cause === undefined ?
    new TypeError("statelift: malformed dehydrated payload")
  : new TypeError("statelift: malformed dehydrated payload", { cause });

const allocateTransportNode = (node: WireNode) => {
  switch (node[0]) {
    case "object": {
      return node[1] === 1 ? Object.create(null) : {};
    }
    case "array": {
      const array: unknown[] = [];
      array.length = node[1];
      return array;
    }
    case "map": {
      const map = new Map<unknown, unknown>();
      if (node[1] === 1) Object.defineProperty(map, COLLECTION_BRAND, { value: "map" });
      return map;
    }
    case "set": {
      const set = new Set<unknown>();
      if (node[1] === 1) Object.defineProperty(set, COLLECTION_BRAND, { value: "set" });
      return set;
    }
    case "date": {
      return new Date(0);
    }
    case "regexp": {
      return Reflect.construct(RegExp, [node[1], node[2]]);
    }
    case "array-buffer": {
      return new ArrayBuffer(node[1].length);
    }
    case "view": {
      return null;
    }
    case "url": {
      return new URL(node[1]);
    }
    case "url-search-params": {
      return new URLSearchParams(node[1]);
    }
    default: {
      throw malformedPayloadError();
    }
  }
};

const decodeSpecialNumber = (value: WireValue & ["number", string]) => {
  switch (value[1]) {
    case "nan": {
      return Number.NaN;
    }
    case "positive-infinity": {
      return Infinity;
    }
    case "negative-infinity": {
      return -Infinity;
    }
    case "negative-zero": {
      return -0;
    }
    default: {
      throw new TypeError("statelift: dehydrated payload contains an invalid value");
    }
  }
};

const decodeWireNumber = (value: WireNumber) =>
  typeof value === "number" ? value : decodeSpecialNumber(value);

export const decodeTransportEnvelope = (envelope: unknown): unknown => {
  if (!isTransportEnvelope(envelope)) throw malformedPayloadError();
  const allocated: (object | null)[] = Array.from({ length: envelope.nodes.length }, () => null);

  // Normalize constructor-domain failures behind the transport boundary error.
  try {
    for (let id = 0; id < envelope.nodes.length; id++) {
      const node = envelope.nodes[id];
      if (node === undefined) {
        throw new TypeError(`statelift: dehydrated payload is missing node ${id}`);
      }
      allocated[id] = allocateTransportNode(node);
    }
  } catch (error) {
    throw malformedPayloadError(error);
  }

  const objectAt = (id: number) => {
    const object = allocated[id];
    if (object === undefined || object === null) {
      throw new TypeError(`statelift: dehydrated payload references missing node ${id}`);
    }
    return object;
  };

  const decodeValue = (value: WireValue): unknown => {
    if (!Array.isArray(value)) return value;
    switch (value[0]) {
      case "undefined": {
        return undefined;
      }
      case "number": {
        return decodeSpecialNumber(value);
      }
      case "bigint": {
        return BigInt(value[1]);
      }
      case "symbol": {
        return decodeSymbol(value[1]);
      }
      case "ref": {
        return objectAt(value[1]);
      }
      default: {
        throw new TypeError("statelift: dehydrated payload contains an invalid value");
      }
    }
  };

  for (let id = 0; id < envelope.nodes.length; id++) {
    const node = envelope.nodes[id];
    if (node?.[0] !== "view") continue;
    const buffer = decodeValue(node[2]);
    if (!isArrayBufferValue(buffer)) {
      throw new TypeError("statelift: dehydrated typed-array view must reference an ArrayBuffer node");
    }
    allocated[id] = viewFromBuffer(node[1], buffer, node[3], node[4]);
  }

  for (const object of allocated) {
    if (object !== null) decodedTransportNodes.add(object);
  }

  const defineProperties = (target: object, properties: WireProperty[]) => {
    for (const [wireKey, enumerable, wireValue] of properties) {
      const key = decodeKey(wireKey);
      const defined = Reflect.defineProperty(target, key, {
        value: decodeValue(wireValue),
        enumerable: enumerable === 1,
        configurable: true,
        writable: true,
      });
      if (!defined) {
        throw new TypeError(`statelift: cannot define dehydrated property "${String(key)}"`);
      }
    }
  };

  for (let id = 0; id < envelope.nodes.length; id++) {
    const node = envelope.nodes[id];
    if (node === undefined) {
      throw new TypeError(`statelift: dehydrated payload is missing node ${id}`);
    }
    const target = objectAt(id);
    switch (node[0]) {
      case "object": {
        defineProperties(target, node[3]);
        break;
      }
      case "array": {
        defineProperties(target, node[3]);
        break;
      }
      case "map": {
        for (const [key, value] of node[2]) {
          Map.prototype.set.call(target, decodeValue(key), decodeValue(value));
        }
        break;
      }
      case "set": {
        for (const value of node[2]) Set.prototype.add.call(target, decodeValue(value));
        break;
      }
      case "date": {
        const time = decodeValue(node[1]);
        if (typeof time !== "number") {
          throw new TypeError("statelift: dehydrated Date node must contain a numeric timestamp");
        }
        Date.prototype.setTime.call(target, time);
        break;
      }
      case "regexp": {
        Reflect.set(target, "lastIndex", decodeWireNumber(node[3]));
        break;
      }
      case "array-buffer": {
        if (!isArrayBufferValue(target)) {
          throw new TypeError("statelift: dehydrated ArrayBuffer node decoded to the wrong type");
        }
        new Uint8Array(target).set(node[1]);
        break;
      }
      case "view":
      case "url":
      case "url-search-params": {
        break;
      }
      default: {
        throw malformedPayloadError();
      }
    }
  }

  for (let id = 0; id < envelope.nodes.length; id++) {
    const node = envelope.nodes[id];
    if (node === undefined) {
      throw new TypeError(`statelift: dehydrated payload is missing node ${id}`);
    }
    if ((node[0] === "object" && node[2] === 1) || (node[0] === "array" && node[2] === 1)) {
      Object.freeze(objectAt(id));
    }
  }

  return decodeValue(envelope.root);
};

export function encodeTransport<T extends {}>(value: unknown): Dehydrated<T>;
export function encodeTransport(value: unknown): string {
  if (transportRequiresLocalSnapshot(value)) {
    describePath("$", "a reactive collection member with actions or accessors");
  }
  return `${TRANSPORT_PREFIX}${JSON.stringify(encodeGraph(value))}`;
}

export const encodeTransportEnvelope = (value: unknown): TransportEnvelope => encodeGraph(value);

export type DevtoolsGraphEncodeResult =
  | { kind: "encode-failed"; graph: undefined; requiresLocalSnapshot: true; encodeError: unknown }
  | { kind: "encoded"; graph: TransportEnvelope; requiresLocalSnapshot: boolean };

/** Encodes one graph and reports whether time travel requires the local snapshot. */
export const encodeDevtoolsGraph = (value: unknown): DevtoolsGraphEncodeResult => {
  const metadata: DevtoolsEncodeMetadata = { hasOwnStateCode: [], childRefs: [] };
  let graph: TransportEnvelope;
  try {
    graph = encodeGraph(value, metadata);
  } catch (encodeError) {
    return { kind: "encode-failed", graph: undefined, requiresLocalSnapshot: true, encodeError };
  }

  const visited = new Set<number>();
  const stack: number[] = [];
  for (let id = 0; id < graph.nodes.length; id++) {
    const node = graph.nodes[id];
    if (node === undefined) continue;
    if ((node[0] === "map" || node[0] === "set") && node[1] === 1) {
      const entryRefs = metadata.childRefs[id];
      if (entryRefs !== undefined) stack.push(...entryRefs);
    }
  }
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    if (metadata.hasOwnStateCode[id] === true) {
      return { kind: "encoded", graph, requiresLocalSnapshot: true };
    }
    const childRefs = metadata.childRefs[id];
    if (childRefs !== undefined) stack.push(...childRefs);
  }
  return { kind: "encoded", graph, requiresLocalSnapshot: false };
};

export const isDehydrated = (value: unknown): value is Dehydrated<{}> =>
  typeof value === "string" && value.startsWith(TRANSPORT_PREFIX);

export const decodeTransport = (value: string): unknown => {
  if (!value.startsWith(TRANSPORT_PREFIX)) throw malformedPayloadError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(TRANSPORT_PREFIX.length));
  } catch (error) {
    throw malformedPayloadError(error);
  }
  return decodeTransportEnvelope(parsed);
};

const collectionBrand = (value: object) => {
  const brand = Reflect.getOwnPropertyDescriptor(value, COLLECTION_BRAND)?.value;
  return brand === "map" || brand === "set" ? brand : null;
};

const previewNumber = (value: number) => {
  if (Number.isNaN(value)) return "[NaN]";
  if (value === Infinity) return "[Infinity]";
  if (value === -Infinity) return "[-Infinity]";
  if (Object.is(value, -0)) return "[-0]";
  return value;
};

export const createTransportPreview = (value: unknown): unknown => {
  const references = new WeakMap<object, string>();
  const preview = (current: unknown, path: string): unknown => {
    if (current === undefined) return "[undefined]";
    if (typeof current === "bigint") return `${current}n`;
    if (typeof current === "symbol") return String(current);
    if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
    if (typeof current === "number") return previewNumber(current);
    if (typeof current !== "object" || current === null) return current;

    const previousPath = references.get(current);
    if (previousPath !== undefined) return `[Reference ${previousPath}]`;
    references.set(current, path);

    if (Array.isArray(current)) {
      const result: unknown[] = Array.from({ length: current.length });
      for (let index = 0; index < current.length; index++) {
        result[index] =
          Object.hasOwn(current, index) ? preview(current[index], `${path}[${index}]`) : "[empty]";
      }
      return result;
    }

    const objectName = opaqueObjectType(current);
    if (objectName === "Map") {
      const entries: unknown[] = [];
      let index = 0;
      for (const [key, entryValue] of Map.prototype.entries.call(current)) {
        entries.push([
          preview(key, `${path}.entries[${index}][0]`),
          preview(entryValue, `${path}.entries[${index}][1]`),
        ]);
        index++;
      }
      return { $type: collectionBrand(current) === "map" ? "proxyMap" : "Map", entries };
    }
    if (objectName === "Set") {
      const values: unknown[] = [];
      let index = 0;
      for (const entryValue of Set.prototype.values.call(current)) {
        values.push(preview(entryValue, `${path}.values[${index}]`));
        index++;
      }
      return { $type: collectionBrand(current) === "set" ? "proxySet" : "Set", values };
    }
    if (objectName === "Date") {
      const time = Date.prototype.getTime.call(current);
      return Number.isNaN(time) ? "[Invalid Date]" : Date.prototype.toISOString.call(current);
    }
    if (objectName === "RegExp") return RegExp.prototype.toString.call(current);
    if (objectName === "ArrayBuffer") return `[ArrayBuffer ${Reflect.get(current, "byteLength")} bytes]`;
    if (ArrayBuffer.isView(current)) return `[${opaqueObjectName(current)} ${current.byteLength} bytes]`;
    if (objectName === "URL") return Reflect.get(current, "href");
    if (objectName === "URLSearchParams") return URLSearchParams.prototype.toString.call(current);

    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor?.enumerable !== true) continue;
      result[typeof key === "string" ? key : `[${String(key)}]`] = preview(
        Reflect.get(current, key),
        `${path}.${String(key)}`,
      );
    }
    return result;
  };
  return preview(value, "$state");
};
