import { COLLECTION_BRAND, unwrapProxy } from "./proxy";

export interface ProxyMap<K, V> {
  readonly [COLLECTION_BRAND]: "map";
  readonly size: number;
  get: (key: K) => V | undefined;
  set: (key: K, value: V) => this;
  has: (key: K) => boolean;
  delete: (key: K) => boolean;
  clear: () => void;
  forEach: (callback: (value: V, key: K, map: ProxyMap<K, V>) => void, thisArg?: unknown) => void;
  keys: () => IterableIterator<K>;
  values: () => IterableIterator<V>;
  entries: () => IterableIterator<[K, V]>;
  [Symbol.iterator]: () => IterableIterator<[K, V]>;
}

export interface ProxySet<T> {
  readonly [COLLECTION_BRAND]: "set";
  readonly size: number;
  add: (value: T) => this;
  has: (value: T) => boolean;
  delete: (value: T) => boolean;
  clear: () => void;
  forEach: (callback: (value: T, value2: T, set: ProxySet<T>) => void, thisArg?: unknown) => void;
  keys: () => IterableIterator<T>;
  values: () => IterableIterator<T>;
  entries: () => IterableIterator<[T, T]>;
  [Symbol.iterator]: () => IterableIterator<T>;
  union: (other: Iterable<T>) => ProxySet<T>;
  intersection: (other: Iterable<T>) => ProxySet<T>;
  difference: (other: Iterable<T>) => ProxySet<T>;
  symmetricDifference: (other: Iterable<T>) => ProxySet<T>;
  isSubsetOf: (other: Iterable<T>) => boolean;
  isSupersetOf: (other: Iterable<T>) => boolean;
}

type Slot = { key: unknown; value?: unknown };
type ContainerShape = { size: number; slots: Record<string, Slot> };

type ContainerInternals = {
  index: Map<unknown, string>;
  counter: number;
  mutation: CollectionMutation | null;
};

type CollectionMutation = {
  owners: Set<object>;
  completions: (() => void)[];
};

type CollectionMutationOutcome<T> = { status: "returned"; value: T } | { status: "threw"; error: unknown };

type CollectionMutationBatch = {
  owner: object;
  start: () => void;
  complete: () => void;
};

// Collection metadata must not become reactive state.
const containerInternals = new WeakMap<{}, ContainerInternals>();
const targetInternals = new WeakMap<object, ContainerInternals>();

const rawOf = (container: ContainerShape) => unwrapProxy(container, true);

const unwrapKey = (key: unknown) => (typeof key === "object" && key !== null ? unwrapProxy(key, true) : key);

const getInternals = (raw: ContainerShape) => {
  let internals = containerInternals.get(raw);
  if (!internals) {
    internals = { index: new Map(), counter: 0, mutation: null };
    containerInternals.set(raw, internals);
  }
  targetInternals.set(raw, internals);
  targetInternals.set(raw.slots, internals);
  if (internals.index.size !== raw.size) {
    internals.index.clear();
    let maxId = -1;
    for (const [slotId, slot] of Object.entries(raw.slots)) {
      internals.index.set(slot.key, slotId);
      const numeric = Number(slotId.slice(1));
      if (Number.isFinite(numeric) && numeric > maxId) maxId = numeric;
    }
    internals.counter = maxId + 1;
  }
  return internals;
};

const runCollectionMutation = <T>(raw: ContainerShape, mutate: () => T) => {
  const internals = getInternals(raw);
  if (internals.mutation !== null) return mutate();

  const mutation: CollectionMutation = { owners: new Set(), completions: [] };
  internals.mutation = mutation;
  let outcome: CollectionMutationOutcome<T>;
  try {
    outcome = { status: "returned", value: mutate() };
  } catch (error) {
    outcome = { status: "threw", error };
  }
  internals.mutation = null;
  let firstError: unknown;
  let hasError = false;
  for (const complete of mutation.completions) {
    try {
      complete();
    } catch (error) {
      if (!hasError) {
        firstError = error;
        hasError = true;
      }
    }
  }
  if (hasError) throw firstError;
  if (outcome.status === "threw") throw outcome.error;
  return outcome.value;
};

export const joinCollectionMutation = (target: object, batch: CollectionMutationBatch): boolean => {
  const mutation = targetInternals.get(target)?.mutation;
  if (mutation === null || mutation === undefined) return false;
  if (mutation.owners.has(batch.owner)) return true;

  mutation.owners.add(batch.owner);
  batch.start();
  mutation.completions.push(batch.complete);
  return true;
};

const readPairsSnapshot = (container: ContainerShape) => {
  const out: [unknown, unknown][] = [];
  const { slots } = container;
  for (const slotId of Object.keys(slots)) {
    const slot = slots[slotId];
    if (slot) {
      out.push([slot.key, slot.value]);
    }
  }
  return out;
};

function mapGet(this: ContainerShape, key: unknown) {
  const internals = getInternals(rawOf(this));
  const slotId = internals.index.get(unwrapKey(key));
  if (slotId === undefined) {
    void this.size; // absent key: subscribe to structural changes
    return undefined;
  }
  return this.slots[slotId]?.value;
}

function mapSet(this: ContainerShape, key: unknown, value: unknown) {
  const raw = rawOf(this);
  const internals = getInternals(raw);
  return runCollectionMutation(raw, () => {
    const rawKey = unwrapKey(key);
    const existing = internals.index.get(rawKey);
    if (existing === undefined) {
      const slotId = `s${internals.counter++}`;
      const slot = { key: rawKey, value };
      internals.index.set(rawKey, slotId);
      this.slots[slotId] = slot;
      this.size = raw.size + 1;
    } else {
      const slot = this.slots[existing];
      if (slot === undefined) {
        throw new TypeError("statelift: reactive collection index references a missing slot");
      }
      targetInternals.set(unwrapProxy(slot, true), internals);
      slot.value = value;
    }
    return this;
  });
}

const deleteSlot = (slots: Record<string, Slot>, slotId: string) => {
  if (!Reflect.deleteProperty(slots, slotId)) {
    throw new TypeError("statelift: cannot delete a reactive collection entry");
  }
};

function collectionHas(this: ContainerShape, key: unknown) {
  const internals = getInternals(rawOf(this));
  const slotId = internals.index.get(unwrapKey(key));
  if (slotId === undefined) {
    void this.size; // absent key: subscribe to structural changes
    return false;
  }
  return this.slots[slotId] !== undefined;
}

function collectionDelete(this: ContainerShape, key: unknown) {
  const raw = rawOf(this);
  const internals = getInternals(raw);
  return runCollectionMutation(raw, () => {
    const rawKey = unwrapKey(key);
    const slotId = internals.index.get(rawKey);
    if (slotId === undefined) return false;
    internals.index.delete(rawKey);
    deleteSlot(this.slots, slotId);
    this.size = raw.size - 1;
    return true;
  });
}

function collectionClear(this: ContainerShape) {
  const raw = rawOf(this);
  const internals = getInternals(raw);
  runCollectionMutation(raw, () => {
    for (const slotId of Object.keys(raw.slots)) {
      deleteSlot(this.slots, slotId);
    }
    internals.index.clear();
    if (raw.size > 0) {
      this.size = 0;
    }
  });
}

function mapForEach(
  this: ContainerShape,
  callback: (value: unknown, key: unknown, map: unknown) => void,
  thisArg?: unknown,
) {
  for (const [key, value] of readPairsSnapshot(this)) {
    Reflect.apply(callback, thisArg, [value, key, this]);
  }
}

function mapKeys(this: ContainerShape) {
  return readPairsSnapshot(this)
    .map(([key]) => key)
    .values();
}

function mapValues(this: ContainerShape) {
  return readPairsSnapshot(this)
    .map(([, value]) => value)
    .values();
}

function mapEntries(this: ContainerShape) {
  return readPairsSnapshot(this).values();
}

function setAdd(this: ContainerShape, value: unknown) {
  const raw = rawOf(this);
  const internals = getInternals(raw);
  return runCollectionMutation(raw, () => {
    const rawValue = unwrapKey(value);
    if (internals.index.get(rawValue) === undefined) {
      const slotId = `s${internals.counter++}`;
      const slot = { key: rawValue };
      internals.index.set(rawValue, slotId);
      this.slots[slotId] = slot;
      this.size = raw.size + 1;
    }
    return this;
  });
}

function setForEach(
  this: ContainerShape,
  callback: (value: unknown, value2: unknown, set: unknown) => void,
  thisArg?: unknown,
) {
  for (const [key] of readPairsSnapshot(this)) {
    Reflect.apply(callback, thisArg, [key, key, this]);
  }
}

function setEntries(this: ContainerShape) {
  return readPairsSnapshot(this)
    .map(([key]): [unknown, unknown] => [key, key])
    .values();
}

const toRawNativeSet = (other: Iterable<unknown>) => {
  const out = new Set<unknown>();
  for (const value of other) {
    out.add(unwrapKey(value));
  }
  return out;
};

const readKeysSnapshot = (container: ContainerShape) => readPairsSnapshot(container).map(([key]) => key);

function setUnion(this: ContainerShape, other: Iterable<unknown>) {
  const result = proxySet(readKeysSnapshot(this));
  for (const value of other) {
    result.add(value);
  }
  return result;
}

function setIntersection(this: ContainerShape, other: Iterable<unknown>) {
  const otherSet = toRawNativeSet(other);
  return proxySet(readKeysSnapshot(this).filter((key) => otherSet.has(unwrapKey(key))));
}

function setDifference(this: ContainerShape, other: Iterable<unknown>) {
  const otherSet = toRawNativeSet(other);
  return proxySet(readKeysSnapshot(this).filter((key) => !otherSet.has(unwrapKey(key))));
}

function setSymmetricDifference(this: ContainerShape, other: Iterable<unknown>) {
  const mineKeys = readKeysSnapshot(this);
  const mineRaw = new Set(mineKeys.map(unwrapKey));
  const otherSet = toRawNativeSet(other);
  const out: unknown[] = mineKeys.filter((key) => !otherSet.has(unwrapKey(key)));
  for (const value of otherSet) {
    if (!mineRaw.has(value)) out.push(value);
  }
  return proxySet(out);
}

function setIsSubsetOf(this: ContainerShape, other: Iterable<unknown>) {
  const otherSet = toRawNativeSet(other);
  return readKeysSnapshot(this).every((key) => otherSet.has(unwrapKey(key)));
}

function setIsSupersetOf(this: ContainerShape, other: Iterable<unknown>) {
  const mine = new Set(readKeysSnapshot(this).map(unwrapKey));
  for (const value of other) {
    if (!mine.has(unwrapKey(value))) return false;
  }
  return true;
}

const mapMethods: [string | symbol, unknown][] = [
  ["get", mapGet],
  ["set", mapSet],
  ["has", collectionHas],
  ["delete", collectionDelete],
  ["clear", collectionClear],
  ["forEach", mapForEach],
  ["keys", mapKeys],
  ["values", mapValues],
  ["entries", mapEntries],
  [Symbol.iterator, mapEntries],
];

const setMethods: [string | symbol, unknown][] = [
  ["add", setAdd],
  ["has", collectionHas],
  ["delete", collectionDelete],
  ["clear", collectionClear],
  ["forEach", setForEach],
  ["keys", mapKeys],
  ["values", mapKeys],
  ["entries", setEntries],
  [Symbol.iterator, mapKeys],
  ["union", setUnion],
  ["intersection", setIntersection],
  ["difference", setDifference],
  ["symmetricDifference", setSymmetricDifference],
  ["isSubsetOf", setIsSubsetOf],
  ["isSupersetOf", setIsSupersetOf],
];

const createContainer = (brand: "map" | "set", methods: [string | symbol, unknown][]) => {
  const container: ContainerShape = { slots: {}, size: 0 };
  Object.defineProperty(container, COLLECTION_BRAND, { value: brand, enumerable: false });
  for (const [name, fn] of methods) {
    Object.defineProperty(container, name, {
      value: fn,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return container;
};

type TaggedMap = { __map: [unknown, unknown][] };
type TaggedSet = { __set: unknown[] };

type CollectionData = { brand: "map"; entries: [unknown, unknown][] } | { brand: "set"; values: unknown[] };

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const objectTag = (value: object) => {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "[object Object]";
  }
};

const isNativeMap = (value: unknown): value is Map<unknown, unknown> => {
  if (!isRecord(value) || objectTag(value) !== "[object Map]") return false;
  try {
    Map.prototype.has.call(value, COLLECTION_BRAND);
    return true;
  } catch {
    return false;
  }
};

const isNativeSet = (value: unknown): value is Set<unknown> => {
  if (!isRecord(value) || objectTag(value) !== "[object Set]") return false;
  try {
    Set.prototype.has.call(value, COLLECTION_BRAND);
    return true;
  } catch {
    return false;
  }
};

const isTaggedMap = (value: unknown): value is TaggedMap =>
  isRecord(value) &&
  Array.isArray(value.__map) &&
  value.__map.every((entry) => Array.isArray(entry) && entry.length === 2);

const isTaggedSet = (value: unknown): value is TaggedSet => isRecord(value) && Array.isArray(value.__set);

const invalidCollectionPayload = (brand: "map" | "set") => {
  const collectionName = brand === "map" ? "proxyMap" : "proxySet";
  throw new TypeError(`statelift: cannot restore ${collectionName} from the supplied value`);
};

const readPlainCollectionData = (
  brand: "map" | "set",
  value: Record<PropertyKey, unknown>,
): CollectionData => {
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("slots") || !keys.includes("size")) {
    return invalidCollectionPayload(brand);
  }
  if (
    typeof value.size !== "number" ||
    !Number.isInteger(value.size) ||
    value.size < 0 ||
    !isRecord(value.slots)
  ) {
    return invalidCollectionPayload(brand);
  }

  const slotIds = Object.keys(value.slots);
  if (slotIds.length !== value.size) return invalidCollectionPayload(brand);
  if (brand === "map") {
    const entries: [unknown, unknown][] = [];
    for (const slotId of slotIds) {
      const slot = value.slots[slotId];
      // JSON omits undefined slot fields, which decode as undefined.
      if (
        !isRecord(slot) ||
        Array.isArray(slot) ||
        Object.keys(slot).some((slotKey) => slotKey !== "key" && slotKey !== "value")
      ) {
        return invalidCollectionPayload(brand);
      }
      entries.push([slot.key, slot.value]);
    }
    return { brand, entries };
  }

  const values: unknown[] = [];
  for (const slotId of slotIds) {
    const slot = value.slots[slotId];
    if (!isRecord(slot) || Array.isArray(slot) || Object.keys(slot).some((slotKey) => slotKey !== "key")) {
      return invalidCollectionPayload(brand);
    }
    values.push(slot.key);
  }
  return { brand, values };
};

export const readCollectionData = (brand: "map" | "set", value: unknown): CollectionData => {
  if (brand === "map" && isNativeMap(value)) {
    return { brand, entries: [...Map.prototype.entries.call(value)] };
  }
  if (brand === "set" && isNativeSet(value)) {
    return { brand, values: [...Set.prototype.values.call(value)] };
  }
  if (!isRecord(value)) return invalidCollectionPayload(brand);

  if (Object.hasOwn(value, "__map") || Object.hasOwn(value, "__set")) {
    if (brand === "map" && isTaggedMap(value) && !Object.hasOwn(value, "__set")) {
      return { brand, entries: value.__map };
    }
    if (brand === "set" && isTaggedSet(value) && !Object.hasOwn(value, "__map")) {
      return { brand, values: value.__set };
    }
    return invalidCollectionPayload(brand);
  }

  if (Object.hasOwn(value, "slots") || Object.hasOwn(value, "size")) {
    return readPlainCollectionData(brand, value);
  }
  return invalidCollectionPayload(brand);
};

/** Reactive Map-shaped container; not a native Map. */
export const proxyMap = <K, V>(entries?: Iterable<readonly [K, V]>): ProxyMap<K, V> => {
  const map = createContainer("map", mapMethods) as unknown as ProxyMap<K, V>;
  if (entries) {
    for (const [key, value] of entries) {
      map.set(key, value);
    }
  }
  return map;
};

/** Reactive Set-shaped container; not a native Set. */
export const proxySet = <T>(values?: Iterable<T>): ProxySet<T> => {
  const set = createContainer("set", setMethods) as unknown as ProxySet<T>;
  if (values) {
    for (const value of values) {
      set.add(value);
    }
  }
  return set;
};
