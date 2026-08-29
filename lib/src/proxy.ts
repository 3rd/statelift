import { isFunction } from "./utils";

export const UNWRAP_PROXY_KEY: unique symbol = Symbol.for("statelift.proxy.unwrap.v1");
export const TRACK_WITH_PRESERVED_DEPENDENCIES: unique symbol = Symbol.for(
  "statelift.consumer.track-with-preserved-dependencies.v1",
);

/** Identifies proxyMap and proxySet containers during snapshotting. */
export const COLLECTION_BRAND: unique symbol = Symbol.for("statelift.collection.brand.v1");

/** Identifies getters excluded from store and useProxyState caches. */
export const UNCACHED_BRAND: unique symbol = Symbol.for("statelift.computed.uncached.v1");

// Membership prevents foreign proxies from spoofing UNWRAP_PROXY_KEY.
const stateliftProxyTargets = new WeakSet<object>();

export const isUncachedGetter = (getter: () => unknown): boolean =>
  Reflect.getOwnPropertyDescriptor(getter, UNCACHED_BRAND)?.value === true;

const objectTag = (value: object) => {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "[object Object]";
  }
};

const BRAND_CHECK_KEY = {};

const passesBrandCheck = (operation: Function, receiver: object, args: unknown[] = []) => {
  try {
    Reflect.apply(operation, receiver, args);
    return true;
  } catch {
    return false;
  }
};

const passesGetterBrandCheck = (prototype: object, prop: string, receiver: object) => {
  let current: object | null = prototype;
  while (current !== null) {
    const getter = Reflect.getOwnPropertyDescriptor(current, prop)?.get;
    if (getter !== undefined) return passesBrandCheck(getter, receiver);
    current = Reflect.getPrototypeOf(current);
  }
  return false;
};

const hasPromisePrototypeShape = (value: object) => {
  let current = Reflect.getPrototypeOf(value);
  while (current !== null) {
    const tag = Reflect.getOwnPropertyDescriptor(current, Symbol.toStringTag)?.value;
    if (tag === "Promise") {
      return (
        typeof Reflect.getOwnPropertyDescriptor(current, "then")?.value === "function" &&
        typeof Reflect.getOwnPropertyDescriptor(current, "catch")?.value === "function"
      );
    }
    current = Reflect.getPrototypeOf(current);
  }
  return false;
};

type OpaqueObjectType = string | null;

export const opaqueObjectType = (value: object): OpaqueObjectType => {
  if (ArrayBuffer.isView(value)) return objectTag(value).slice(8, -1);

  const tag = objectTag(value);
  switch (tag) {
    case "[object Map]": {
      return passesBrandCheck(Map.prototype.has, value, [BRAND_CHECK_KEY]) ? "Map" : null;
    }
    case "[object Set]": {
      return passesBrandCheck(Set.prototype.has, value, [BRAND_CHECK_KEY]) ? "Set" : null;
    }
    case "[object WeakMap]": {
      return passesBrandCheck(WeakMap.prototype.has, value, [BRAND_CHECK_KEY]) ? "WeakMap" : null;
    }
    case "[object WeakSet]": {
      return passesBrandCheck(WeakSet.prototype.has, value, [BRAND_CHECK_KEY]) ? "WeakSet" : null;
    }
    case "[object Date]": {
      return passesBrandCheck(Date.prototype.getTime, value) ? "Date" : null;
    }
    case "[object RegExp]": {
      return passesGetterBrandCheck(RegExp.prototype, "source", value) ? "RegExp" : null;
    }
    case "[object ArrayBuffer]": {
      return passesGetterBrandCheck(ArrayBuffer.prototype, "byteLength", value) ? "ArrayBuffer" : null;
    }
    case "[object Promise]": {
      // Promise has no side-effect-free public brand operation.
      return hasPromisePrototypeShape(value) ? "Promise" : null;
    }
    case "[object URL]": {
      return typeof URL !== "undefined" && passesGetterBrandCheck(URL.prototype, "href", value) ?
          "URL"
        : null;
    }
    case "[object URLSearchParams]": {
      return (
          typeof URLSearchParams !== "undefined" &&
            passesBrandCheck(URLSearchParams.prototype.toString, value)
        ) ?
          "URLSearchParams"
        : null;
    }
    default: {
      return null;
    }
  }
};

export const WELL_KNOWN_SYMBOLS: Set<symbol> = new Set<symbol>(
  Object.getOwnPropertyNames(Symbol)
    .map((key) => Symbol[key as keyof SymbolConstructor])
    .filter((value): value is symbol => typeof value === "symbol"),
);

const COMPOUND_ARRAY_METHODS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
export const COMPOUND_COARSE_THRESHOLD = 32;

export const hasInternalSlots = (value: unknown): boolean =>
  typeof value === "object" && value !== null && opaqueObjectType(value) !== null;

export const opaqueObjectName = (value: object): string =>
  opaqueObjectType(value) ?? objectTag(value).slice(8, -1);

export const definePlainDataProperty = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const isInvariantLockedDescriptor = (descriptor: PropertyDescriptor | undefined) =>
  descriptor !== undefined && descriptor.configurable === false && descriptor.writable === false;

const isInvariantLocked = (target: {}, prop: string | symbol) =>
  isInvariantLockedDescriptor(Reflect.getOwnPropertyDescriptor(target, prop));

export type CompoundOp =
  | { type: "delete"; prop: string | symbol }
  | { type: "set"; prop: string | symbol; isNewProperty: boolean };

export type CompoundCompletion = {
  ops: readonly CompoundOp[];
  /** True when property recording exceeded COMPOUND_COARSE_THRESHOLD. */
  coarse: boolean;
  /** False only when the operation cannot detach an object element. */
  mayDetachElements: boolean;
};

type CompoundFrame = {
  target: unknown[];
  lengthBefore: number;
  ops: Map<string | symbol, CompoundOp>;
  coarse: boolean;
  mayDetach: boolean;
};

export type SetMutation = {
  target: {};
  prop: string | symbol;
  value: unknown;
  receiver: {};
  isNewProperty: boolean;
  oldValue: unknown;
  oldArrayLength?: number;
  newArrayLength?: number;
};

export type DescriptorMutation = {
  target: {};
  prop: string | symbol;
  before: PropertyDescriptor | undefined;
  after: PropertyDescriptor;
  oldArrayLength?: number;
  newArrayLength?: number;
};

export type ProxyCallbacks = {
  get: (target: {}, prop: string | symbol, receiver: {}) => void;
  setExistingProperty: (target: {}, prop: string | symbol) => boolean;
  set: (mutation: SetMutation) => void;
  defineProperty: (mutation: DescriptorMutation) => void;
  deleteProperty: (target: {}, prop: string | symbol, oldValue?: unknown) => void;
  ownKeys: (target: {}) => void;
  /** Runs once when a target enters the proxy cache. */
  onWrap?: (target: {}) => void;
  /** Resolves a cached accessor before Reflect.get invokes it. */
  resolveComputed?: (target: {}, prop: string | symbol, targetProxy: {}) => { value: unknown } | undefined;
  /** Wraps array iteration so stores can register one structural dependency. */
  wrapArrayIteration?: (
    target: unknown[],
    prop: string,
    method: (...args: unknown[]) => unknown,
    wrapElement: (target: unknown[], index: number, value: unknown) => unknown,
    targetProxy: {} | undefined,
  ) => ((...args: unknown[]) => unknown) | undefined;
  /** Reports the property changes from one compound array operation. */
  arrayMethodComplete?: (target: unknown[], method: string, completion: CompoundCompletion) => void;
};

export function unwrapProxy<T extends {}>(object: T, deep?: boolean): T;
export function unwrapProxy(object: {}, deep = false): {} {
  if (typeof object !== "object" || object === null) return object;
  const answer: unknown = Reflect.get(object, UNWRAP_PROXY_KEY);
  if (typeof answer !== "object" || answer === null || !stateliftProxyTargets.has(answer)) {
    return object;
  }
  let unwrapped: object = answer;
  if (deep) {
    let next: unknown = Reflect.get(unwrapped, UNWRAP_PROXY_KEY);
    while (
      typeof next === "object" &&
      next !== null &&
      next !== unwrapped &&
      stateliftProxyTargets.has(next)
    ) {
      unwrapped = next;
      next = Reflect.get(unwrapped, UNWRAP_PROXY_KEY);
    }
  }
  return unwrapped;
}

export type SnapshotSharing = {
  isDirty: (target: {}) => boolean;
  cache: WeakMap<{}, unknown>;
  owner: object;
};

type FrozenSnapshotMetadata = {
  array: boolean;
  keys: (string | symbol)[];
  enumerable: boolean[];
};

type SnapshotOrigin = {
  raw: object;
  owner: object;
  frozen?: FrozenSnapshotMetadata;
};

type SnapshotRawOrigin = object | undefined;

const materializedSnapshotNodes = new WeakSet<object>();
const snapshotOrigins = new WeakMap<object, SnapshotOrigin>();

export const isMaterializedSnapshotNode = (value: object): boolean => materializedSnapshotNodes.has(value);

export const getSnapshotOrigin = (value: object, owner: object): SnapshotRawOrigin => {
  const origin = snapshotOrigins.get(value);
  return origin?.owner === owner ? origin.raw : undefined;
};

export const getSnapshotRawOrigin = (value: object): SnapshotRawOrigin => snapshotOrigins.get(value)?.raw;

const markMaterializedSnapshotNode = (value: object, raw: object, owner: object | undefined) => {
  materializedSnapshotNodes.add(value);
  if (owner !== undefined) snapshotOrigins.set(value, { raw, owner });
};

type SnapshotProperty = {
  key: string | symbol;
  value: unknown;
  enumerable: boolean;
};

const snapshotProperties = (value: object, array: boolean) => {
  const properties: SnapshotProperty[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    const propertyValue = Reflect.get(value, key);
    if (typeof propertyValue === "function") continue;
    properties.push({ key, value: propertyValue, enumerable: descriptor.enumerable ?? false });
  }
  return properties;
};

const defineSnapshotProperty = (target: object, property: SnapshotProperty, value: unknown) => {
  Object.defineProperty(target, property.key, {
    value,
    enumerable: property.enumerable,
    configurable: true,
    writable: true,
  });
};

const recordFrozenSnapshotMetadata = (
  value: object,
  raw: object,
  owner: object | undefined,
  array: boolean,
  properties: SnapshotProperty[],
) => {
  if (owner === undefined) return;
  const origin = snapshotOrigins.get(value);
  if (origin?.raw !== raw || origin.owner !== owner) return;
  origin.frozen = {
    array,
    keys: properties.map((property) => property.key),
    enumerable: properties.map((property) => property.enumerable),
  };
};

type SnapshotVerification = {
  rawToSnapshot: WeakMap<object, object>;
  snapshotToRaw: WeakMap<object, object>;
};

const isCurrentSnapshotNode = (
  raw: object,
  cached: object,
  building: WeakMap<object, unknown>,
  sharing: SnapshotSharing,
  verification: SnapshotVerification,
) => {
  const buildingNode = building.get(raw);
  if (buildingNode !== undefined) return buildingNode === cached;
  if (sharing.isDirty(raw)) return false;
  if (hasInternalSlots(raw)) return raw === cached;
  if (Reflect.getOwnPropertyDescriptor(raw, COLLECTION_BRAND)?.value !== undefined) return false;

  const mappedSnapshot = verification.rawToSnapshot.get(raw);
  if (mappedSnapshot !== undefined) return mappedSnapshot === cached;
  const mappedRaw = verification.snapshotToRaw.get(cached);
  if (mappedRaw !== undefined) return mappedRaw === raw;
  verification.rawToSnapshot.set(raw, cached);
  verification.snapshotToRaw.set(cached, raw);

  const rawIsArray = Array.isArray(raw);
  if (rawIsArray !== Array.isArray(cached)) return false;
  if (rawIsArray && (raw as unknown[]).length !== (cached as unknown[]).length) return false;

  const properties = snapshotProperties(raw, rawIsArray);
  const cachedKeys = Reflect.ownKeys(cached).filter((key) => !(rawIsArray && key === "length"));
  if (properties.length !== cachedKeys.length) return false;

  for (const [index, property] of properties.entries()) {
    const cachedKey = cachedKeys[index];
    if (property === undefined || cachedKey === undefined || property.key !== cachedKey) return false;
    const cachedDescriptor = Reflect.getOwnPropertyDescriptor(cached, cachedKey);
    if (cachedDescriptor?.enumerable !== property.enumerable) return false;
    const cachedValue = cachedDescriptor?.value;
    if (property.value === null || typeof property.value !== "object") {
      if (!Object.is(property.value, cachedValue)) return false;
      continue;
    }
    if (cachedValue === null || typeof cachedValue !== "object") return false;
    const rawChild = unwrapProxy(property.value, true);
    if (!isCurrentSnapshotNode(rawChild, cachedValue, building, sharing, verification)) return false;
  }
  return true;
};

const isCurrentFrozenSnapshotNode = (
  raw: object,
  cached: object,
  building: WeakMap<object, unknown>,
  sharing: SnapshotSharing,
  visited: WeakSet<object>,
) => {
  const buildingNode = building.get(raw);
  if (buildingNode !== undefined) return buildingNode === cached;
  if (sharing.isDirty(raw)) return false;
  if (hasInternalSlots(raw)) return raw === cached;
  if (Reflect.getOwnPropertyDescriptor(raw, COLLECTION_BRAND)?.value !== undefined) return false;

  const origin = snapshotOrigins.get(cached);
  const metadata = origin?.frozen;
  if (origin?.raw !== raw || origin.owner !== sharing.owner || metadata === undefined) return false;
  if (visited.has(raw)) return true;
  visited.add(raw);

  const rawIsArray = Array.isArray(raw);
  if (rawIsArray !== metadata.array || rawIsArray !== Array.isArray(cached)) return false;
  if (rawIsArray && (raw as unknown[]).length !== (cached as unknown[]).length) return false;

  let propertyIndex = 0;
  for (const key of Reflect.ownKeys(raw)) {
    if (rawIsArray && key === "length") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined) continue;
    const propertyValue = Reflect.get(raw, key);
    if (typeof propertyValue === "function") continue;
    if (key !== metadata.keys[propertyIndex]) return false;
    if ((descriptor.enumerable ?? false) !== metadata.enumerable[propertyIndex]) return false;

    const cachedValue = Reflect.get(cached, key);
    if (propertyValue === null || typeof propertyValue !== "object") {
      if (!Object.is(propertyValue, cachedValue)) return false;
    } else {
      if (cachedValue === null || typeof cachedValue !== "object") return false;
      const rawChild = unwrapProxy(propertyValue, true);
      if (!isCurrentFrozenSnapshotNode(rawChild, cachedValue, building, sharing, visited)) return false;
    }
    propertyIndex++;
  }
  return propertyIndex === metadata.keys.length;
};

const isReusableSnapshotNode = (
  raw: object,
  cached: object,
  building: WeakMap<object, unknown>,
  sharing: SnapshotSharing,
) => {
  if (Object.isFrozen(cached) && snapshotOrigins.get(cached)?.frozen !== undefined) {
    return isCurrentFrozenSnapshotNode(raw, cached, building, sharing, new WeakSet());
  }
  return isCurrentSnapshotNode(raw, cached, building, sharing, {
    rawToSnapshot: new WeakMap(),
    snapshotToRaw: new WeakMap(),
  });
};

const immutableCollectionMutation = (): never => {
  throw new TypeError("statelift: snapshots are immutable");
};

const protectSnapshotCollection = (collection: Map<unknown, unknown> | Set<unknown>) => {
  const methods = collection instanceof Map ? ["set", "delete", "clear"] : ["add", "delete", "clear"];
  for (const method of methods) {
    Object.defineProperty(collection, method, {
      value: immutableCollectionMutation,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  Object.freeze(collection);
};

type SnapshotTreeOptions = {
  freeze: boolean;
  visited?: WeakMap<object, unknown>;
  collectionsAs?: "native" | "plain";
  sharing?: SnapshotSharing;
  owner?: object;
};

export const snapshotTree = (value: unknown, options: SnapshotTreeOptions): unknown => {
  const {
    freeze,
    visited = new WeakMap(),
    collectionsAs = "native",
    sharing,
    owner = sharing?.owner,
  } = options;
  if (value === null || typeof value !== "object") return value;

  const raw = unwrapProxy(value as object, true);

  // Persistence keeps collection slots because JSON omits native Map and Set entries.
  const brand =
    collectionsAs === "native" ?
      (raw as { [COLLECTION_BRAND]?: "map" | "set" })[COLLECTION_BRAND]
    : undefined;
  if (brand) {
    const existingCollection = visited.get(raw);
    if (existingCollection !== undefined) return existingCollection;
    const slots = (raw as { slots?: Record<string, { key: unknown; value?: unknown }> }).slots ?? {};
    if (brand === "map") {
      const result = new Map<unknown, unknown>();
      visited.set(raw, result);
      Object.defineProperty(result, COLLECTION_BRAND, { value: "map" });
      for (const slot of Object.values(slots)) {
        result.set(slot.key, snapshotTree(slot.value, { freeze, visited, collectionsAs, owner }));
      }
      if (freeze) protectSnapshotCollection(result);
      return result;
    }
    const result = new Set<unknown>();
    visited.set(raw, result);
    Object.defineProperty(result, COLLECTION_BRAND, { value: "set" });
    for (const slot of Object.values(slots)) {
      result.add(snapshotTree(slot.key, { freeze, visited, collectionsAs, owner }));
    }
    if (freeze) protectSnapshotCollection(result);
    return result;
  }

  if (hasInternalSlots(raw)) return raw;

  const existing = visited.get(raw);
  if (existing !== undefined) return existing;

  if (Array.isArray(raw)) {
    const cachedArray = sharing?.cache.get(raw);
    if (sharing && Array.isArray(cachedArray) && isReusableSnapshotNode(raw, cachedArray, visited, sharing)) {
      return cachedArray;
    }

    const result: unknown[] = [];
    result.length = raw.length;
    markMaterializedSnapshotNode(result, raw, owner);
    visited.set(raw, result);
    const properties = snapshotProperties(raw, true);
    for (const property of properties) {
      defineSnapshotProperty(
        result,
        property,
        snapshotTree(property.value, { freeze, visited, collectionsAs, sharing, owner }),
      );
    }
    if (freeze) {
      Object.freeze(result);
      recordFrozenSnapshotMetadata(result, raw, owner, true, properties);
    }
    sharing?.cache.set(raw, result);
    return result;
  }

  const cachedNode = sharing?.cache.get(raw);
  if (
    sharing &&
    typeof cachedNode === "object" &&
    cachedNode !== null &&
    !Array.isArray(cachedNode) &&
    isReusableSnapshotNode(raw, cachedNode, visited, sharing)
  ) {
    return cachedNode;
  }

  const result: Record<string, unknown> = {};
  markMaterializedSnapshotNode(result, raw, owner);
  visited.set(raw, result);
  const properties = snapshotProperties(raw, false);
  for (const property of properties) {
    defineSnapshotProperty(
      result,
      property,
      snapshotTree(property.value, { freeze, visited, collectionsAs, sharing, owner }),
    );
  }
  if (freeze) {
    Object.freeze(result);
    recordFrozenSnapshotMetadata(result, raw, owner, false, properties);
  }
  sharing?.cache.set(raw, result);
  return result;
};

export function unwrapDeepProxy<T>(value: T, visited?: WeakMap<object, unknown>): T;
export function unwrapDeepProxy(value: unknown, visited = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;

  const unwrapped = unwrapProxy(value, true);
  if (hasInternalSlots(unwrapped)) return unwrapped;

  const existing = visited.get(unwrapped);
  if (existing !== undefined) return existing;

  if (Array.isArray(unwrapped)) {
    const result: unknown[] = [];
    result.length = unwrapped.length;
    visited.set(unwrapped, result);
    for (let index = 0; index < unwrapped.length; index++) {
      if (Object.hasOwn(unwrapped, index)) {
        result[index] = unwrapDeepProxy(unwrapped[index], visited);
      }
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  visited.set(unwrapped, result);
  for (const key of Object.keys(unwrapped)) {
    definePlainDataProperty(result, key, unwrapDeepProxy(Reflect.get(unwrapped, key), visited));
  }
  return result;
}

const descriptorsEqual = (left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined) => {
  if (left === undefined || right === undefined) return left === right;
  if (left.configurable !== right.configurable || left.enumerable !== right.enumerable) return false;
  const leftIsData = Object.hasOwn(left, "value");
  const rightIsData = Object.hasOwn(right, "value");
  if (leftIsData !== rightIsData) return false;
  if (leftIsData) {
    return left.writable === right.writable && Object.is(left.value, right.value);
  }
  return left.get === right.get && left.set === right.set;
};

const findPropertyDescriptor = (target: {}, prop: string | symbol) => {
  let current: object | null = target;
  while (current !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, prop);
    if (descriptor !== undefined) return descriptor;
    current = Reflect.getPrototypeOf(current);
  }
  return undefined;
};

type DeepProxyOptions = {
  callbacks?: Partial<ProxyCallbacks>;
  unwrapSet?: boolean;
  strict?: boolean;
};

export type TrackingViewCallbacks = {
  beginRead: () => boolean;
  endRead: (claimed: boolean) => void;
  trackGet: (target: {}, prop: string | symbol, claimed: boolean) => void;
  trackOwnKeys: (target: {}, claimed: boolean) => void;
  /** Adds consumer bookkeeping to the canonical iteration wrapper. */
  wrapIterationMethod?: (
    target: unknown[],
    prop: string,
    method: (...args: unknown[]) => unknown,
    wrapElement: (target: unknown[], index: number, value: unknown) => unknown,
    viewProxy: {},
  ) => ((...args: unknown[]) => unknown) | undefined;
};

export type DeepProxyView = {
  wrap: <V>(value: V) => V;
  createRevocableRoot: () => { proxy: {}; revoke: () => void };
  invalidate: (rawTarget: {}) => void;
};
type RootPropertySetCallback = (target: {}, prop: string | symbol, value: unknown, oldValue: unknown) => void;
type PrivateRootLifecycle = { descriptorsFinalized: boolean };

const createDeepProxyInternal = <T extends object>(
  object: T,
  options: DeepProxyOptions | undefined,
  ownedRoot: boolean,
  privateRootLifecycle: PrivateRootLifecycle | undefined,
  setRootProperty: RootPropertySetCallback | undefined,
) => {
  const callbacks = options?.callbacks;
  const strict = options?.strict === true;
  const unwrapSet = options?.unwrapSet === true;
  const privateOwnedRoot = privateRootLifecycle !== undefined;
  const proxyCache = new WeakMap<{}, {}>();
  const setFrames: {
    receiverTarget: {};
    prop: string | symbol;
    suppressReceiverDefinition: boolean;
    trustedReceiverDefinition: boolean;
  }[] = [];
  let setFrameDepth = 0;
  const compoundFrames: CompoundFrame[] = [];
  let compoundMethodCache:
    | WeakMap<{}, Map<string, { method: Function; wrapped: (...args: unknown[]) => unknown }>>
    | undefined;
  const privateRootLocks = privateOwnedRoot ? new Map<string | symbol, boolean>() : undefined;
  let privateRootExposed = false;
  let lastPrivateRootProp: string | symbol | undefined;
  let lastPrivateRootLocked = false;

  const invariantLockedForGet = (target: {}, prop: string | symbol) => {
    if (
      privateRootLifecycle === undefined ||
      !privateRootLifecycle.descriptorsFinalized ||
      privateRootExposed ||
      target !== object
    ) {
      return isInvariantLocked(target, prop);
    }
    if (lastPrivateRootProp === prop) return lastPrivateRootLocked;
    let locked = privateRootLocks?.get(prop);
    if (locked === undefined) {
      locked = isInvariantLocked(target, prop);
      privateRootLocks?.set(prop, locked);
    }
    lastPrivateRootProp = prop;
    lastPrivateRootLocked = locked;
    return locked;
  };

  const cachePrivateRootDescriptor = (target: {}, prop: string | symbol, descriptor: PropertyDescriptor) => {
    if (
      privateRootLifecycle === undefined ||
      !privateRootLifecycle.descriptorsFinalized ||
      privateRootExposed ||
      target !== object
    ) {
      return;
    }
    const locked = descriptor.configurable === false && descriptor.writable === false;
    privateRootLocks?.set(prop, locked);
    lastPrivateRootProp = prop;
    lastPrivateRootLocked = locked;
  };

  const forgetPrivateRootDescriptor = (target: {}, prop: string | symbol) => {
    if (
      privateRootLifecycle === undefined ||
      !privateRootLifecycle.descriptorsFinalized ||
      privateRootExposed ||
      target !== object
    ) {
      return;
    }
    privateRootLocks?.delete(prop);
    if (lastPrivateRootProp === prop) lastPrivateRootProp = undefined;
  };

  const compoundFrameFor = (target: {}) => {
    for (let index = compoundFrames.length - 1; index >= 0; index--) {
      const frame = compoundFrames[index];
      if (frame?.target === target) return frame;
    }
    return undefined;
  };
  const recordCompoundOp = (frame: CompoundFrame, op: CompoundOp) => {
    if (frame.coarse) return;
    frame.ops.set(op.prop, op);
    if (frame.ops.size > COMPOUND_COARSE_THRESHOLD) {
      frame.coarse = true;
      frame.ops.clear();
    }
  };
  const throwOnStrictBuiltIn = (proxyTarget: {}) => {
    const objectName = opaqueObjectName(proxyTarget);
    throw new Error(
      `statelift: strict mode rejects ${objectName}; Statelift treats built-in objects as opaque and cannot ` +
        `track their internal changes. Replace the whole value when it changes, use proxyMap()/proxySet() ` +
        `for collections, or disable strict mode to accept opaque values`,
    );
  };
  const handler: ProxyHandler<{}> = {};
  const ensureCanonicalProxy = (proxyTarget: {}) => {
    const cachedProxy = proxyCache.get(proxyTarget);
    if (cachedProxy !== undefined) return cachedProxy;
    const proxy = new Proxy(proxyTarget, handler);
    stateliftProxyTargets.add(proxyTarget);
    proxyCache.set(proxyTarget, proxy);
    callbacks?.onWrap?.(proxyTarget);
    return proxy;
  };
  const wrapObjectValue = (value: object, target: {}, prop: string | symbol) => {
    if (invariantLockedForGet(target, prop)) return value;

    const directCachedProxy = proxyCache.get(value);
    if (directCachedProxy !== undefined) return directCachedProxy;

    const proxyTarget = unwrapProxy(value, true);
    const cachedProxy = proxyCache.get(proxyTarget);
    if (cachedProxy !== undefined) return cachedProxy;

    if (hasInternalSlots(proxyTarget)) {
      if (strict) throwOnStrictBuiltIn(proxyTarget);
      return proxyTarget;
    }
    if (Object.isFrozen(proxyTarget)) return proxyTarget;

    return ensureCanonicalProxy(proxyTarget);
  };
  const wrapIterationElement = (target: unknown[], index: number, value: unknown) => {
    if (typeof value !== "object" || value === null) return value;
    return wrapObjectValue(value, target, String(index));
  };
  const unwrapAssignedValue = (value: unknown) => {
    if (!unwrapSet || typeof value !== "object" || value === null) return value;
    return unwrapProxy(value, true);
  };

  const resolveCompoundWrapper = (target: unknown[], prop: string, value: Function) => {
    let targetMethods = compoundMethodCache?.get(target);
    if (targetMethods === undefined) {
      targetMethods = new Map();
      (compoundMethodCache ??= new WeakMap()).set(target, targetMethods);
    }
    const cachedMethod = targetMethods.get(prop);
    if (cachedMethod?.method === value) {
      return cachedMethod.wrapped;
    }
    const wrappedCompound = function (this: unknown, ...args: unknown[]) {
      const receiverTarget = typeof this === "object" && this !== null ? unwrapProxy(this, true) : this;
      if (!Array.isArray(receiverTarget)) {
        return value.apply(this, args);
      }
      if (this === receiverTarget || proxyCache.get(receiverTarget) === undefined) {
        return value.apply(this, args);
      }

      const frame: CompoundFrame = {
        target: receiverTarget,
        lengthBefore: receiverTarget.length,
        ops: new Map<string | symbol, CompoundOp>(),
        coarse: false,
        mayDetach: true,
      };
      compoundFrames.push(frame);
      try {
        return value.apply(this, args);
      } finally {
        compoundFrames.pop();
        // Preserve the implicit length change filtered by the same-value guard.
        if (frame.lengthBefore !== receiverTarget.length) {
          recordCompoundOp(frame, { type: "set", prop: "length", isNewProperty: false });
        }

        const parent = compoundFrameFor(receiverTarget);
        if (parent) {
          if (frame.coarse) {
            parent.coarse = true;
            parent.ops.clear();
          } else {
            for (const operation of frame.ops.values()) {
              recordCompoundOp(parent, operation);
            }
          }
          if (frame.mayDetach) parent.mayDetach = true;
        } else if (frame.coarse || frame.ops.size > 0) {
          callbacks?.arrayMethodComplete?.(receiverTarget, prop, {
            ops: [...frame.ops.values()],
            coarse: frame.coarse,
            mayDetachElements: frame.mayDetach,
          });
        }
      }
    };
    targetMethods.set(prop, { method: value, wrapped: wrappedCompound });
    return wrappedCompound;
  };
  const handlerMethods: ProxyHandler<{}> = {
    get: (target, prop, receiver) => {
      if (prop === UNWRAP_PROXY_KEY) {
        if (privateOwnedRoot && target === object) privateRootExposed = true;
        return target;
      }

      if (typeof prop === "symbol" && WELL_KNOWN_SYMBOLS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      if (privateOwnedRoot && callbacks?.get === undefined && !Array.isArray(target)) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "object" || value === null) return value;
        return wrapObjectValue(value, target, prop);
      }

      let value: unknown;
      const computed = callbacks?.resolveComputed?.(target, prop, proxyCache.get(target) ?? receiver);
      if (computed) {
        value = computed.value;
      } else {
        value = Reflect.get(target, prop, receiver);
      }
      let result = value;

      if (typeof value === "object" && value !== null) {
        result = wrapObjectValue(value, target, prop);
        callbacks?.get?.(target, prop, receiver);
        return result;
      } else if (typeof value !== "function") {
        callbacks?.get?.(target, prop, receiver);
        return value;
      }

      const arrayMethodIsOwn =
        Array.isArray(target) && Reflect.getOwnPropertyDescriptor(target, prop) !== undefined;
      if (arrayMethodIsOwn) {
        callbacks?.get?.(target, prop, receiver);
        return value;
      }

      if (
        Array.isArray(target) &&
        typeof prop === "string" &&
        COMPOUND_ARRAY_METHODS.has(prop) &&
        typeof value === "function"
      ) {
        const wrappedCompound = resolveCompoundWrapper(target, prop, value);
        callbacks?.get?.(target, prop, receiver);
        return wrappedCompound;
      }

      if (Array.isArray(target) && typeof prop === "string" && isFunction(value)) {
        const wrappedIteration = callbacks?.wrapArrayIteration?.(
          target,
          prop,
          value,
          wrapIterationElement,
          proxyCache.get(target),
        );
        if (wrappedIteration !== undefined) result = wrappedIteration;
      }

      callbacks?.get?.(target, prop, receiver);
      return result;
    },
    set: (target, prop, value, receiver) => {
      const isNewProperty = !Object.hasOwn(target, prop);
      const targetIsArray = Array.isArray(target);
      const oldArrayLength = targetIsArray ? target.length : undefined;
      const unwrappedValue = unwrapAssignedValue(value);

      // Inspect descriptors so the no-op guard never invokes an accessor.
      let oldValue: unknown;
      let isSameValueDataWrite = false;
      let ownDescriptor: PropertyDescriptor | undefined;
      if (!isNewProperty) {
        ownDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
        if (ownDescriptor && Object.hasOwn(ownDescriptor, "value")) {
          oldValue = ownDescriptor.value;
          isSameValueDataWrite = Object.is(ownDescriptor.value, unwrappedValue);
        }
      }

      const canonicalReceiver = proxyCache.get(target) === receiver;
      const trustedRootTarget = ownedRoot && target === object;
      if (
        trustedRootTarget &&
        canonicalReceiver &&
        !targetIsArray &&
        ownDescriptor !== undefined &&
        Object.hasOwn(ownDescriptor, "value") &&
        ownDescriptor.writable === true
      ) {
        if (isSameValueDataWrite) return true;
        const result = Reflect.set(target, prop, unwrappedValue, target);
        if (result) {
          if (setRootProperty) {
            setRootProperty(target, prop, unwrappedValue, oldValue);
          } else {
            callbacks?.set?.({
              target,
              prop,
              value: unwrappedValue,
              receiver,
              isNewProperty,
              oldValue,
              oldArrayLength,
              newArrayLength: undefined,
            });
          }
        }
        return result;
      }

      const receiverTarget = canonicalReceiver ? target : unwrapProxy(receiver, true);
      const resolvedDescriptor =
        trustedRootTarget && ownDescriptor !== undefined ?
          ownDescriptor
        : findPropertyDescriptor(target, prop);
      const suppressReceiverDefinition =
        resolvedDescriptor === undefined || Object.hasOwn(resolvedDescriptor, "value");
      const trustedReceiverDefinition = trustedRootTarget && canonicalReceiver;
      const setFrame =
        setFrames[setFrameDepth] ??
        (setFrames[setFrameDepth] = {
          receiverTarget,
          prop,
          suppressReceiverDefinition,
          trustedReceiverDefinition,
        });
      setFrame.receiverTarget = receiverTarget;
      setFrame.prop = prop;
      setFrame.suppressReceiverDefinition = suppressReceiverDefinition;
      setFrame.trustedReceiverDefinition = trustedReceiverDefinition;
      setFrameDepth++;
      let result: boolean;
      try {
        result = Reflect.set(target, prop, unwrappedValue, receiver);
      } finally {
        setFrameDepth--;
        setFrame.receiverTarget = object;
        setFrame.prop = UNWRAP_PROXY_KEY;
      }

      if (!result) return false;

      if (target !== receiverTarget) {
        return result;
      }

      const newArrayLength = targetIsArray ? target.length : undefined;
      const effectiveDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (
        suppressReceiverDefinition &&
        oldArrayLength === newArrayLength &&
        descriptorsEqual(ownDescriptor, effectiveDescriptor)
      ) {
        return result;
      }
      let effectiveValue = unwrappedValue;
      if (effectiveDescriptor && Object.hasOwn(effectiveDescriptor, "value")) {
        effectiveValue = effectiveDescriptor.value;
      }
      if (!isNewProperty && !targetIsArray && callbacks?.setExistingProperty?.(target, prop)) {
        return result;
      }

      const compoundFrame = compoundFrameFor(target);
      if (compoundFrame) {
        recordCompoundOp(compoundFrame, { type: "set", prop, isNewProperty });
      } else {
        callbacks?.set?.({
          target,
          prop,
          value: effectiveValue,
          receiver,
          isNewProperty,
          oldValue,
          oldArrayLength,
          newArrayLength,
        });
      }
      return result;
    },
    deleteProperty: (target, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      const oldValue =
        descriptor && Object.hasOwn(descriptor, "value") ? (descriptor.value as unknown) : undefined;
      const result = Reflect.deleteProperty(target, prop);
      if (result && descriptor !== undefined) {
        forgetPrivateRootDescriptor(target, prop);
        const compoundFrame = compoundFrameFor(target);
        if (compoundFrame) {
          recordCompoundOp(compoundFrame, { type: "delete", prop });
        } else {
          callbacks?.deleteProperty?.(target, prop, oldValue);
        }
      }
      return result;
    },
    ownKeys: (target) => {
      callbacks?.ownKeys?.(target);
      return Reflect.ownKeys(target);
    },
    has: (target, prop) => {
      const exists = Reflect.has(target, prop);
      callbacks?.get?.(target, prop, target);
      return exists;
    },
    defineProperty: (target, prop, descriptor) => {
      let activeSetFrame: (typeof setFrames)[number] | undefined;
      for (let index = setFrameDepth - 1; index >= 0; index--) {
        const frame = setFrames[index];
        if (frame?.suppressReceiverDefinition && frame.receiverTarget === target && frame.prop === prop) {
          activeSetFrame = frame;
          break;
        }
      }
      if (activeSetFrame?.trustedReceiverDefinition) {
        return Reflect.defineProperty(target, prop, descriptor);
      }

      const before = Reflect.getOwnPropertyDescriptor(target, prop);
      const oldArrayLength = Array.isArray(target) ? target.length : undefined;
      const result = Reflect.defineProperty(target, prop, descriptor);
      if (!result) return false;

      if (activeSetFrame !== undefined) return true;

      const after = Reflect.getOwnPropertyDescriptor(target, prop);
      if (after === undefined) return true;
      cachePrivateRootDescriptor(target, prop, after);
      const newArrayLength = Array.isArray(target) ? target.length : undefined;
      if (descriptorsEqual(before, after) && oldArrayLength === newArrayLength) return true;

      callbacks?.defineProperty?.({
        target,
        prop,
        before,
        after,
        oldArrayLength,
        newArrayLength,
      });
      return result;
    },
  };
  Object.assign(handler, handlerMethods);

  const createTrackingView = (viewCallbacks: TrackingViewCallbacks): DeepProxyView => {
    const viewCache = new WeakMap<{}, {}>();
    const viewHandler: ProxyHandler<{}> = {};
    const wrapViewObjectValue = (value: object, target: {}, prop: string | symbol) => {
      if (invariantLockedForGet(target, prop)) return value;
      const directCached = viewCache.get(value);
      if (directCached !== undefined) return directCached;
      const proxyTarget = unwrapProxy(value, true);
      const cached = viewCache.get(proxyTarget);
      if (cached !== undefined) return cached;
      if (hasInternalSlots(proxyTarget)) {
        if (strict) throwOnStrictBuiltIn(proxyTarget);
        return proxyTarget;
      }
      if (Object.isFrozen(proxyTarget)) return proxyTarget;
      ensureCanonicalProxy(proxyTarget);
      const viewProxy = new Proxy(proxyTarget, viewHandler);
      viewCache.set(proxyTarget, viewProxy);
      return viewProxy;
    };
    const wrapViewElement = (target: unknown[], index: number, value: unknown) => {
      if (typeof value !== "object" || value === null) return value;
      return wrapViewObjectValue(value, target, String(index));
    };
    const viewHandlerMethods: ProxyHandler<{}> = {
      get: (target, prop, receiver) => {
        if (prop === UNWRAP_PROXY_KEY) return target;
        if (typeof prop === "symbol" && WELL_KNOWN_SYMBOLS.has(prop)) {
          return Reflect.get(target, prop, receiver);
        }
        const claimed = viewCallbacks.beginRead();
        let value: unknown;
        let result: unknown;
        try {
          const computed = callbacks?.resolveComputed?.(target, prop, proxyCache.get(target) ?? receiver);
          value = computed ? computed.value : Reflect.get(target, prop, receiver);
          result =
            typeof value === "object" && value !== null ? wrapViewObjectValue(value, target, prop) : value;
        } finally {
          viewCallbacks.endRead(claimed);
        }
        if (
          typeof value === "function" &&
          Array.isArray(target) &&
          typeof prop === "string" &&
          Reflect.getOwnPropertyDescriptor(target, prop) === undefined
        ) {
          if (COMPOUND_ARRAY_METHODS.has(prop)) {
            result = resolveCompoundWrapper(target, prop, value);
          } else {
            const canonicalIteration = callbacks?.wrapArrayIteration?.(
              target,
              prop,
              value as (...args: unknown[]) => unknown,
              wrapIterationElement,
              proxyCache.get(target),
            );
            if (canonicalIteration !== undefined) {
              const viewIteration = viewCallbacks.wrapIterationMethod?.(
                target,
                prop,
                canonicalIteration,
                wrapViewElement,
                viewCache.get(target) ?? receiver,
              );
              result = viewIteration ?? canonicalIteration;
            }
          }
        }
        viewCallbacks.trackGet(target, prop, claimed);
        return result;
      },
      set: (target, prop, value, receiver) =>
        Reflect.set(ensureCanonicalProxy(target), prop, value, receiver),
      defineProperty: (target, prop, descriptor) =>
        Reflect.defineProperty(ensureCanonicalProxy(target), prop, descriptor),
      deleteProperty: (target, prop) => Reflect.deleteProperty(ensureCanonicalProxy(target), prop),
      ownKeys: (target) => {
        const claimed = viewCallbacks.beginRead();
        let keys: (string | symbol)[];
        try {
          keys = Reflect.ownKeys(target);
        } finally {
          viewCallbacks.endRead(claimed);
        }
        viewCallbacks.trackOwnKeys(target, claimed);
        return keys;
      },
      has: (target, prop) => {
        const claimed = viewCallbacks.beginRead();
        let exists: boolean;
        try {
          exists = Reflect.has(target, prop);
        } finally {
          viewCallbacks.endRead(claimed);
        }
        viewCallbacks.trackGet(target, prop, claimed);
        return exists;
      },
    };
    Object.assign(viewHandler, viewHandlerMethods);
    const wrapViewValue = <V>(value: V) => {
      if (typeof value !== "object" || value === null) return value;
      const proxyTarget = unwrapProxy(value, true);
      if (proxyCache.get(proxyTarget) === undefined) return value;
      const cached = viewCache.get(proxyTarget);
      if (cached !== undefined) return cached as V;
      if (hasInternalSlots(proxyTarget) || Object.isFrozen(proxyTarget)) return proxyTarget as V;
      const viewProxy = new Proxy(proxyTarget, viewHandler);
      viewCache.set(proxyTarget, viewProxy);
      return viewProxy as V;
    };
    return {
      wrap: wrapViewValue,
      createRevocableRoot: () => {
        const revocable = Proxy.revocable(object, viewHandler);
        viewCache.set(object, revocable.proxy);
        return revocable;
      },
      invalidate: (rawTarget) => {
        if (rawTarget !== object) viewCache.delete(rawTarget);
      },
    };
  };

  const proxy = new Proxy(object, handler);
  stateliftProxyTargets.add(object);
  proxyCache.set(object, proxy);
  callbacks?.onWrap?.(object);
  return { proxy: proxy as T, createView: createTrackingView };
};

export const createDeepProxy = <T extends object>(object: T, options?: DeepProxyOptions): T =>
  createDeepProxyInternal(object, options, false, undefined, undefined).proxy;

type RootProxyOptions = {
  callbacks: Partial<ProxyCallbacks>;
  setRootProperty?: RootPropertySetCallback;
  strict?: boolean;
};
type RootProxyResult<T extends {}> = {
  state: T;
  target: T;
  createView: (viewCallbacks: TrackingViewCallbacks) => DeepProxyView;
};

const createRootProxyResult = <T extends {}>(
  builder: (root: T) => T,
  options: RootProxyOptions | undefined,
  privateOwnedRoot: boolean,
): RootProxyResult<T> => {
  const skeleton = {} as T;
  const privateRootLifecycle = privateOwnedRoot ? { descriptorsFinalized: false } : undefined;
  const { proxy: root, createView } = createDeepProxyInternal(
    skeleton,
    {
      callbacks: options?.callbacks,
      unwrapSet: true,
      strict: options?.strict,
    },
    true,
    privateRootLifecycle,
    options?.setRootProperty,
  );

  const builderResult = builder(root);
  const builderResultIsObject = typeof builderResult === "object" && builderResult !== null;
  const prototype = builderResultIsObject ? Reflect.getPrototypeOf(builderResult) : null;
  const collectionDescriptor =
    builderResultIsObject ? Reflect.getOwnPropertyDescriptor(builderResult, COLLECTION_BRAND) : undefined;
  if (
    !builderResultIsObject ||
    Array.isArray(builderResult) ||
    hasInternalSlots(builderResult) ||
    collectionDescriptor !== undefined ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new TypeError("statelift: createStore root must be a plain record");
  }
  if (prototype === null) {
    Reflect.setPrototypeOf(skeleton, null);
  }
  const descriptors = Object.getOwnPropertyDescriptors(builderResult);
  Object.defineProperties(skeleton, descriptors);
  if (privateRootLifecycle !== undefined) privateRootLifecycle.descriptorsFinalized = true;

  return { state: root, target: skeleton, createView };
};

export const createRootProxy = <T extends {}>(builder: (root: T) => T, options?: RootProxyOptions): T =>
  createRootProxyResult(builder, options, false).state;

export const createStoreRootProxy = <T extends {}>(
  builder: (root: T) => T,
  options?: RootProxyOptions,
): RootProxyResult<T> => createRootProxyResult(builder, options, true);
