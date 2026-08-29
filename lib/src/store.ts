import type {
  DeepProxyView,
  DescriptorMutation,
  ProxyCallbacks,
  SetMutation,
  TrackingViewCallbacks,
} from "./proxy";
import {
  joinCollectionMutation,
  proxyMap,
  type ProxyMap,
  proxySet,
  type ProxySet,
  readCollectionData,
} from "./collections";
import { initPersist, normalizePersistOptions, type PersistHandle, type PersistOptions } from "./persist";
import {
  COLLECTION_BRAND,
  createStoreRootProxy,
  getSnapshotOrigin,
  hasInternalSlots,
  isMaterializedSnapshotNode,
  isUncachedGetter,
  opaqueObjectType,
  snapshotTree,
  TRACK_WITH_PRESERVED_DEPENDENCIES,
  UNCACHED_BRAND,
  unwrapProxy,
} from "./proxy";
import {
  decodeTransport,
  type Dehydrated,
  encodeTransport,
  isDecodedTransportNode,
  isDehydrated,
} from "./transport";
import { IS_DEV, isArrayIndex, isFunction } from "./utils";

export type Store<T extends {}> = {
  readonly state: T;
};
type StoreListener = { callback: () => void };
type DependencyCollector = (target: ConsumerTarget, prop: ConsumerTargetProp) => void;
type TrackingContext = {
  currentConsumer: ConsumerRecord | null;
  currentDependencyCollector: DependencyCollector | null;
};
type StoreInternals<T extends {}> = Store<T> & {
  trackingContext: TrackingContext;
  ensureTrackingCallbacksEnabled: () => void;
  createConsumerView: (viewCallbacks: TrackingViewCallbacks) => DeepProxyView;
  trackContextDependency: (target: ConsumerTarget, prop: ConsumerTargetProp) => void;
  trackContextOwnKeys: (target: ConsumerTarget) => void;
  hasComputedCell: (target: ConsumerTarget) => boolean;
  registerConsumer: (consumer: ConsumerRecord) => () => void;
  registerDependency: (consumer: ConsumerRecord, target: ConsumerTarget, prop: ConsumerTargetProp) => void;
  refreshConsumerDependencies: (consumer: ConsumerRecord, mode?: "retain-links") => void;
  registerListener: (listener: StoreListener) => () => void;
  getVersion: () => number;
  startBatch: () => void;
  endBatch: () => void;
  hydrate: (data: unknown) => void;
  getActionLabel: () => string | null;
  runWithActionLabel: <R>(label: string, fn: () => R) => R;
  buildSnapshot: () => unknown;
};
export type Selector<T extends {}, R> = (state: T) => R;

type SnapshotFunction = (...args: never[]) => unknown;
type SnapshotBuiltIn =
  | ArrayBuffer
  | ArrayBufferView
  | Date
  | Map<unknown, unknown>
  | Promise<unknown>
  | RegExp
  | Set<unknown>
  | URL
  | URLSearchParams
  | WeakMap<object, unknown>
  | WeakSet<object>;

type NormalizeSnapshotObject<T> = { [K in keyof T]: T[K] };

/** A deep-readonly snapshot with methods removed and getters materialized. */
export type Snapshot<T> =
  T extends SnapshotFunction ? never
  : T extends SnapshotBuiltIn ? T
  : T extends ProxyMap<infer K, infer V> ? ReadonlyMap<K, Snapshot<V>>
  : T extends ProxySet<infer E> ? ReadonlySet<Snapshot<E>>
  : T extends readonly (infer E)[] ? readonly Snapshot<E>[]
  : T extends object ?
    NormalizeSnapshotObject<
      {
        readonly [K in keyof T as Extract<T[K], SnapshotFunction> extends never ? K : never]: Snapshot<T[K]>;
      } & {
        readonly [K in keyof T as Extract<T[K], SnapshotFunction> extends never ? never
        : Exclude<T[K], SnapshotFunction> extends never ? never
        : K]?: Snapshot<Exclude<T[K], SnapshotFunction>>;
      }
    >
  : T;

type Consumer<T extends {}> = {
  proxy: T;
  activate: () => void;
  destroy: () => void;
  /** Clears dependencies before the consumer re-reads them. */
  refreshDependencies: () => void;
  /** Runs a tracked read after refreshing dependencies. */
  track: <R>(fn: (state: T) => R) => R;
  /** Wraps a selected store proxy for render-time tracking. */
  wrap: <V>(value: V) => V;
};
type ConsumerTracking<T extends {}> = {
  store: Store<T>;
  storeInternals: StoreInternals<{}>;
  trackingContext: TrackingContext;
  consumerRecord: ConsumerRecord;
  pendingDependencyTarget: ConsumerTarget | null;
  pendingDependencyProp: ConsumerTargetProp;
  pendingDependencyVersion: number;
  pendingDependencies: Map<ConsumerTarget, Map<ConsumerTargetProp, number>> | null;
  collectDependency: DependencyCollector;
  observedVersion: number;
  iteratedArrays: WeakSet<ConsumerTarget> | null;
  trackDepth: number;
};
type InternalConsumer<T extends {}> = Consumer<T> & {
  [TRACK_WITH_PRESERVED_DEPENDENCIES]: <R>(fn: (state: T) => R) => R;
};
type CreatedConsumer<T extends {}> = {
  consumer: InternalConsumer<T>;
  tracking: ConsumerTracking<T>;
};
type ConsumerTarget = {};
type ConsumerTargetProp = string | symbol;
type ConsumerCallbacks = { rerender: () => void; revoke: (target: ConsumerTarget) => void };
type PropertyObserverList = {
  target: ConsumerTarget;
  prop: ConsumerTargetProp;
  head: PropertyObserverEdge | null;
  tail: PropertyObserverEdge | null;
  ownerTargetMap: ObserverListsMap;
  pruned: boolean;
};
type PropertyObserverEdge = {
  observers: PropertyObserverList;
  consumer: ConsumerRecord;
  dependencyIndex: number;
  previous: PropertyObserverEdge | null;
  next: PropertyObserverEdge | null;
};
type ConsumerRecord = ConsumerCallbacks & {
  deliveryClass: "computed" | "ordinary";
  active: boolean;
  queued: boolean;
  dependencies: ConsumerDependencyEdges;
  reusableEdges: ConsumerDependencyEdges;
  observedLists: Set<PropertyObserverList> | null;
  replayingStableDependencyPrefix: boolean;
  retainingDependencies: boolean;
  retainedDependencyCount: number;
};
type ObserverListsMap = WeakMap<ConsumerTarget, Map<ConsumerTargetProp, PropertyObserverList>>;
type ConsumerDependencyEdges = PropertyObserverEdge | PropertyObserverEdge[] | null;

const createConsumerRecord = (
  callbacks: ConsumerCallbacks,
  deliveryClass: "computed" | "ordinary",
): ConsumerRecord => ({
  ...callbacks,
  deliveryClass,
  active: false,
  queued: false,
  dependencies: null,
  reusableEdges: null,
  observedLists: null,
  replayingStableDependencyPrefix: false,
  retainingDependencies: false,
  retainedDependencyCount: 0,
});

const detachObserverEdge = (edge: PropertyObserverEdge) => {
  const { observers, previous, next } = edge;
  if (previous === null) {
    observers.head = next;
    if (next === null) {
      observers.tail = null;
      observers.pruned = true;
      const ownerMap = observers.ownerTargetMap.get(observers.target);
      if (ownerMap?.get(observers.prop) === observers) {
        ownerMap.delete(observers.prop);
        if (ownerMap.size === 0) observers.ownerTargetMap.delete(observers.target);
      }
      return;
    }
    next.previous = null;
    edge.next = null;
    return;
  }
  if (next === null) {
    observers.tail = previous;
    previous.next = null;
    edge.previous = null;
    return;
  }
  previous.next = next;
  next.previous = previous;
  edge.previous = null;
  edge.next = null;
};

const dependencyEdgeCount = (edges: ConsumerDependencyEdges) => {
  if (edges === null) return 0;
  return Array.isArray(edges) ? edges.length : 1;
};

const dependencyEdgeAt = (edges: ConsumerDependencyEdges, index: number) => {
  if (edges === null) return undefined;
  if (Array.isArray(edges)) return edges[index];
  return index === 0 ? edges : undefined;
};

const truncateDependencyEdges = (edges: ConsumerDependencyEdges, length: number): ConsumerDependencyEdges => {
  if (edges === null || length <= 0) return null;
  if (!Array.isArray(edges)) return edges;
  if (length === 1) return edges[0] ?? null;
  const truncatedEdges = edges;
  truncatedEdges.length = length;
  return truncatedEdges;
};

const appendDependencyEdge = (consumer: ConsumerRecord, edge: PropertyObserverEdge) => {
  const dependencies = consumer.dependencies;
  if (dependencies === null) {
    consumer.dependencies = edge;
  } else if (Array.isArray(dependencies)) {
    dependencies.push(edge);
  } else {
    consumer.dependencies = [dependencies, edge];
  }
};

const attachObserverEdge = (
  consumer: ConsumerRecord,
  edge: PropertyObserverEdge,
  observers: PropertyObserverList,
) => {
  edge.observers = observers;
  edge.dependencyIndex = dependencyEdgeCount(consumer.dependencies);
  edge.previous = observers.tail;
  edge.next = null;
  if (observers.tail === null) observers.head = edge;
  else observers.tail.next = edge;
  observers.tail = edge;
  appendDependencyEdge(consumer, edge);
};

const refreshConsumerDependencies = (consumer: ConsumerRecord, mode?: "retain-links") => {
  const dependencies = consumer.dependencies;
  if (mode === "retain-links" && dependencies !== null) {
    consumer.retainingDependencies = true;
    consumer.retainedDependencyCount = 0;
    consumer.replayingStableDependencyPrefix = false;
    consumer.observedLists = null;
    return;
  }

  consumer.retainingDependencies = false;
  consumer.retainedDependencyCount = 0;
  const dependencyCount = dependencyEdgeCount(dependencies);
  for (let index = 0; index < dependencyCount; index++) {
    const edge = dependencyEdgeAt(dependencies, index);
    if (edge !== undefined) detachObserverEdge(edge);
  }
  consumer.reusableEdges = consumer.dependencies;
  consumer.dependencies = null;
  consumer.observedLists = null;
  consumer.replayingStableDependencyPrefix = true;
};

const finishRetainedDependencies = (consumer: ConsumerRecord) => {
  if (!consumer.retainingDependencies) return;
  const dependencies = consumer.dependencies;
  const reusableEdges = consumer.reusableEdges;
  const retainedDependencyCount = consumer.retainedDependencyCount;
  const dependencyCount = dependencyEdgeCount(dependencies);
  if (retainedDependencyCount < dependencyCount) {
    for (let index = retainedDependencyCount; index < dependencyCount; index++) {
      const edge = dependencyEdgeAt(dependencies, index);
      if (edge !== undefined) detachObserverEdge(edge);
    }
    consumer.dependencies = truncateDependencyEdges(dependencies, retainedDependencyCount);
  }
  if (dependencyEdgeCount(reusableEdges) > retainedDependencyCount) {
    consumer.reusableEdges = truncateDependencyEdges(reusableEdges, retainedDependencyCount);
  }
  consumer.retainingDependencies = false;
};

const observerEdgeIsActive = (edge: PropertyObserverEdge) =>
  !edge.consumer.retainingDependencies || edge.dependencyIndex < edge.consumer.retainedDependencyCount;

const getObservedLists = (consumer: ConsumerRecord) => {
  let observedLists = consumer.observedLists;
  if (observedLists !== null) return observedLists;
  observedLists = new Set();
  consumer.observedLists = observedLists;
  const dependencyCount = dependencyEdgeCount(consumer.dependencies);
  for (let index = 0; index < dependencyCount; index++) {
    const edge = dependencyEdgeAt(consumer.dependencies, index);
    if (edge !== undefined) observedLists.add(edge.observers);
  }
  return observedLists;
};

const stateToStoreInternalsMap = new WeakMap<{}, StoreInternals<{}>>();
const snapshotOwnerMap = new WeakMap<{}, object>();
const rawTargetCache = new WeakMap<{}, {}>();
const snapshotCache = new WeakMap<{}, { version: number; value: unknown }>();

const requireStoreInternals = <T extends {}>(store: Store<T>) => {
  const internals = stateToStoreInternalsMap.get(store.state);
  if (internals === undefined) throw new Error("statelift: expected a store created by createStore()");
  return internals;
};

/** Returns an immutable, proxy-free snapshot stable until the next effective mutation. */
export const snapshot = <T extends {}>(store: Store<T>): Snapshot<T> => {
  const internals = requireStoreInternals(store);
  const version = internals.getVersion();
  const cached = snapshotCache.get(store.state);
  if (cached?.version === version) return cached.value as Snapshot<T>;

  const value = internals.buildSnapshot();
  snapshotCache.set(store.state, { version, value });
  return value as Snapshot<T>;
};

// Bound retained dirty targets between snapshot builds.
const SNAPSHOT_DIRT_LIMIT = 8192;
const OWNKEYS_DEPENDENCY = Symbol.for("statelift.dependency.own-keys.v1");
const ARRAY_ITERATION_DEPENDENCY = Symbol.for("statelift.dependency.array-iteration.v1");
const ARRAY_ITERATION_METHODS = new Set([
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "values",
  "with",
]);

// These methods preserve native iteration semantics on the raw backing array.
const ITERATION_FAST_PATH_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "map",
  "some",
]);
// map and filter require the default Array species before bypassing the intrinsic.
const SPECIES_CREATING_METHODS = new Set(["filter", "map"]);

const hasDefaultArraySpecies = (target: unknown[]) => {
  const ownConstructor = Reflect.getOwnPropertyDescriptor(target, "constructor");
  if (ownConstructor === undefined) {
    if (Reflect.getPrototypeOf(target) !== Array.prototype) return false;
    const inheritedConstructor = Reflect.getOwnPropertyDescriptor(Array.prototype, "constructor");
    if (
      inheritedConstructor === undefined ||
      !Object.hasOwn(inheritedConstructor, "value") ||
      inheritedConstructor.value !== Array
    ) {
      return false;
    }
  } else if (!Object.hasOwn(ownConstructor, "value") || ownConstructor.value !== Array) {
    return false;
  }
  return Array[Symbol.species] === Array;
};

type IterationElementWrapper = (target: unknown[], index: number, value: unknown) => unknown;
type IterationFastPathOptions = {
  target: unknown[];
  method: string;
  callback: (...args: unknown[]) => unknown;
  thisArg: unknown;
  receiver: {};
  wrapElement: IterationElementWrapper;
};

const runIterationFastPath = ({
  target,
  method,
  callback,
  thisArg,
  receiver,
  wrapElement,
}: IterationFastPathOptions) => {
  const readElement = (index: number) => {
    // Accessors must still receive the proxy as this.
    const value = Reflect.get(target, index, receiver);
    return typeof value === "object" && value !== null ? wrapElement(target, index, value) : value;
  };
  const length = target.length;
  const callbackArgs: unknown[] = [undefined, 0, receiver];
  const invoke = (element: unknown, index: number) => {
    callbackArgs[0] = element;
    callbackArgs[1] = index;
    return Reflect.apply(callback, thisArg, callbackArgs);
  };
  const mapValues = () => {
    const result: unknown[] = [];
    result.length = length;
    for (let index = 0; index < length; index++) {
      if (index in target) result[index] = invoke(readElement(index), index);
    }
    return result;
  };
  const filterValues = () => {
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      if (index in target) {
        const element = readElement(index);
        if (invoke(element, index)) result.push(element);
      }
    }
    return result;
  };
  switch (method) {
    case "map": {
      return mapValues();
    }
    case "filter": {
      return filterValues();
    }
    case "forEach": {
      for (let index = 0; index < length; index++) {
        if (index in target) invoke(readElement(index), index);
      }
      return undefined;
    }
    case "every": {
      for (let index = 0; index < length; index++) {
        if (index in target && !invoke(readElement(index), index)) return false;
      }
      return true;
    }
    case "some": {
      for (let index = 0; index < length; index++) {
        if (index in target && invoke(readElement(index), index)) return true;
      }
      return false;
    }
    case "find": {
      for (let index = 0; index < length; index++) {
        const element = readElement(index);
        if (invoke(element, index)) return element;
      }
      return undefined;
    }
    case "findIndex": {
      for (let index = 0; index < length; index++) {
        if (invoke(readElement(index), index)) return index;
      }
      return -1;
    }
    case "findLast": {
      for (let index = length - 1; index >= 0; index--) {
        const element = readElement(index);
        if (invoke(element, index)) return element;
      }
      return undefined;
    }
    default: {
      for (let index = length - 1; index >= 0; index--) {
        if (invoke(readElement(index), index)) return index;
      }
      return -1;
    }
  }
};

export type StoreOptions<T extends {} = {}> = {
  /** Rejects built-in objects, which cannot be made reactive. Default: false. */
  strict?: boolean;
  /** Persists the store under a key or with full persistence options. */
  persist?: PersistOptions<T> | string;
};

const collectionBrandOf = (value: unknown) => {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = unwrapProxy(value, true);
  const descriptor = Reflect.getOwnPropertyDescriptor(raw, COLLECTION_BRAND);
  return descriptor?.value === "map" || descriptor?.value === "set" ? descriptor.value : undefined;
};

const isProxyMapValue = (value: unknown): value is ProxyMap<unknown, unknown> =>
  collectionBrandOf(value) === "map";

const isProxySetValue = (value: unknown): value is ProxySet<unknown> => collectionBrandOf(value) === "set";

const createReactiveCollection = (brand: "map" | "set") =>
  brand === "map" ? proxyMap<unknown, unknown>() : proxySet<unknown>();

const isMergeableStateRecord = (value: unknown): value is object => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = unwrapProxy(value, true);
  return !hasInternalSlots(raw) && !Object.isFrozen(raw) && collectionBrandOf(raw) === undefined;
};

const isRestorableStateRecord = (value: unknown): value is object => {
  if (isMergeableStateRecord(value)) return true;
  // Materialized snapshots remain records after development freezing.
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && isMaterializedSnapshotNode(value)
  );
};

const targetPropertyValue = (
  target: object,
  key: string | symbol,
  descriptor: PropertyDescriptor | undefined,
) => {
  if (descriptor === undefined) return undefined;
  return Reflect.get(target, key);
};

const writeStateProperty = (target: object, key: string | symbol, value: unknown) => {
  if (key === "__proto__" && !Object.hasOwn(target, key)) {
    const defined = Reflect.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (!defined) throw new TypeError(`statelift: cannot define state property "${String(key)}"`);
    return;
  }
  if (!Reflect.set(target, key, value, target)) {
    throw new TypeError(`statelift: cannot assign state property "${String(key)}"`);
  }
};

const applyCollectionData = (
  targetValue: unknown,
  incomingValue: unknown,
  resolveValue: (value: unknown, currentValue: unknown) => unknown = (value) => value,
  resolveKey: (key: unknown) => unknown = (key) => key,
) => {
  const targetBrand = collectionBrandOf(targetValue);
  if (targetBrand === undefined) return false;
  const data = readCollectionData(targetBrand, incomingValue);
  if (data.brand === "map") {
    if (!isProxyMapValue(targetValue)) return false;
    const entries: [unknown, unknown][] = data.entries.map(([key, value]) => {
      const resolvedKey = resolveKey(key);
      return [resolvedKey, resolveValue(value, targetValue.get(resolvedKey))];
    });
    targetValue.clear();
    for (const [key, value] of entries) targetValue.set(key, value);
  } else {
    if (!isProxySetValue(targetValue)) return false;
    const values = data.values.map((value) => resolveValue(value, undefined));
    targetValue.clear();
    for (const value of values) targetValue.add(value);
  }
  return true;
};

type ApplyVisited = WeakMap<object, WeakSet<object>>;

const visitApplyPair = (visited: ApplyVisited, target: object, source: object) => {
  let targets = visited.get(source);
  if (!targets) {
    targets = new WeakSet();
    visited.set(source, targets);
  }
  if (targets.has(target)) return false;
  targets.add(target);
  return true;
};

const validateMergeData = (target: object, source: object, visited: ApplyVisited = new WeakMap()): void => {
  if (!visitApplyPair(visited, target, source)) return;
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (descriptor?.get && !descriptor.set) continue;
    const sourceValue = Reflect.get(source, key);
    const targetValue = targetPropertyValue(target, key, descriptor);
    const targetBrand = collectionBrandOf(targetValue);
    if (targetBrand !== undefined) {
      readCollectionData(targetBrand, sourceValue);
      continue;
    }
    if (isMergeableStateRecord(sourceValue) && isMergeableStateRecord(targetValue)) {
      validateMergeData(targetValue, sourceValue, visited);
    }
  }
};

type MergeGraph = {
  mergedBySource: WeakMap<object, object>;
  preferredTargetBySource: WeakMap<object, object>;
};
type MergeRecords = <T extends object>(
  target: T,
  source: unknown,
  warnContext: string | undefined,
  graph: MergeGraph,
) => T;

const sameAppliedValue = (left: unknown, right: unknown) => {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return Object.is(left, right);
  }
  return unwrapProxy(left, true) === unwrapProxy(right, true);
};

const defineImportedProperty = (
  target: object,
  key: string | symbol,
  value: unknown,
  descriptor: PropertyDescriptor,
) => {
  if (
    !Reflect.defineProperty(target, key, {
      value,
      enumerable: descriptor.enumerable ?? false,
      configurable: true,
      writable: true,
    })
  ) {
    throw new TypeError(`statelift: cannot define imported state property "${String(key)}"`);
  }
};

const cloneImportedValue = (
  currentValue: unknown,
  incomingValue: unknown,
  warnContext: string | undefined,
  graph: MergeGraph,
  mergeRecords: MergeRecords,
): unknown => {
  if (typeof incomingValue !== "object" || incomingValue === null) return incomingValue;
  const incoming = unwrapProxy(incomingValue, true);
  const clone = (current: unknown, value: unknown) =>
    cloneImportedValue(current, value, warnContext, graph, mergeRecords);
  const existing = graph.mergedBySource.get(incoming);
  if (existing !== undefined) return existing;

  const currentBrand = collectionBrandOf(currentValue);
  if (currentBrand !== undefined && typeof currentValue === "object" && currentValue !== null) {
    graph.mergedBySource.set(incoming, currentValue);
    applyCollectionData(
      currentValue,
      incoming,
      (value, current) => clone(current, value),
      (key) => (isDecodedTransportNode(incoming) ? clone(undefined, key) : key),
    );
    return currentValue;
  }

  const incomingBrand = collectionBrandOf(incoming);
  if (incomingBrand !== undefined) {
    const result = createReactiveCollection(incomingBrand);
    graph.mergedBySource.set(incoming, result);
    applyCollectionData(
      result,
      incoming,
      (value) => clone(undefined, value),
      (key) => (isDecodedTransportNode(incoming) ? clone(undefined, key) : key),
    );
    return result;
  }

  const incomingType = opaqueObjectType(incoming);
  if (
    isDecodedTransportNode(incoming) &&
    incomingType === "Map" &&
    collectionBrandOf(incoming) === undefined
  ) {
    const result = new Map<unknown, unknown>();
    graph.mergedBySource.set(incoming, result);
    for (const [key, value] of Map.prototype.entries.call(incoming)) {
      result.set(clone(undefined, key), clone(undefined, value));
    }
    return result;
  }
  if (
    isDecodedTransportNode(incoming) &&
    incomingType === "Set" &&
    collectionBrandOf(incoming) === undefined
  ) {
    const result = new Set<unknown>();
    graph.mergedBySource.set(incoming, result);
    for (const value of Set.prototype.values.call(incoming)) {
      result.add(clone(undefined, value));
    }
    return result;
  }

  if (hasInternalSlots(incoming) || Object.isFrozen(incoming)) {
    graph.mergedBySource.set(incoming, incoming);
    return incoming;
  }

  if (Array.isArray(incoming)) {
    const result: unknown[] = [];
    result.length = incoming.length;
    graph.mergedBySource.set(incoming, result);
    for (const key of Reflect.ownKeys(incoming)) {
      if (key === "length") continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(incoming, key);
      if (descriptor === undefined) continue;
      defineImportedProperty(result, key, clone(undefined, Reflect.get(incoming, key)), descriptor);
    }
    return result;
  }

  if (isMergeableStateRecord(incoming)) {
    const preferredTarget = graph.preferredTargetBySource.get(incoming);
    const target = preferredTarget ?? (isMergeableStateRecord(currentValue) ? currentValue : undefined);
    if (target !== undefined) {
      graph.mergedBySource.set(incoming, target);
      mergeRecords(target, incoming, warnContext, graph);
      return target;
    }
    const result = Object.create(Reflect.getPrototypeOf(incoming) === null ? null : Object.prototype);
    graph.mergedBySource.set(incoming, result);
    for (const key of Reflect.ownKeys(incoming)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(incoming, key);
      if (descriptor === undefined) continue;
      defineImportedProperty(result, key, clone(undefined, Reflect.get(incoming, key)), descriptor);
    }
    return result;
  }

  graph.mergedBySource.set(incoming, incoming);
  return incoming;
};

const deepMerge = <T extends object>(
  target: T,
  source: unknown,
  warnContext?: string,
  graph: MergeGraph = { mergedBySource: new WeakMap(), preferredTargetBySource: new WeakMap() },
): T => {
  if (!source || typeof source !== "object") return target;
  const incoming = unwrapProxy(source, true);
  const existing = graph.mergedBySource.get(incoming);
  if (existing !== undefined && existing !== target) return target;
  graph.mergedBySource.set(incoming, target);
  for (const key of Reflect.ownKeys(incoming)) {
    const sourceValue = Reflect.get(incoming, key);
    const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, key);
    const targetValue = targetPropertyValue(target, key, targetDescriptor);
    if (!isMergeableStateRecord(sourceValue) || !isMergeableStateRecord(targetValue)) continue;
    const sourceObject = unwrapProxy(sourceValue, true);
    if (graph.mergedBySource.get(sourceObject) === undefined) {
      graph.preferredTargetBySource.set(sourceObject, targetValue);
    }
  }
  for (const key of Reflect.ownKeys(incoming)) {
    // Getter-only properties are derived and cannot be assigned.
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (descriptor?.get && !descriptor.set) {
      if (warnContext) {
        console.warn(
          `statelift: ${warnContext}() skipped getter-backed key "${String(key)}" — computed properties are derived, not assigned`,
        );
      }
      continue;
    }

    const sourceVal = Reflect.get(incoming, key);
    const targetVal = targetPropertyValue(target, key, descriptor);
    const merged = cloneImportedValue(targetVal, sourceVal, warnContext, graph, deepMerge);
    if (!sameAppliedValue(targetVal, merged)) {
      writeStateProperty(target, key, merged);
    }
  }
  return target;
};

/** Excludes a getter from computed caching. */
export const uncached = <F extends () => unknown>(getter: F): F => {
  Object.defineProperty(getter, UNCACHED_BRAND, {
    value: true,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return getter;
};

type ComputedCell = {
  consumer: ConsumerRecord;
  target: ConsumerTarget;
  prop: ConsumerTargetProp;
  getter: () => unknown;
  value: unknown;
  dirty: boolean;
  evaluating: boolean;
  targetProxy: {} | undefined;
  unregister: () => void;
};

export const createStoreFromBuilder = <T extends {}>(
  builder: (root: T) => T,
  options?: StoreOptions<T>,
): Store<T> => {
  const snapshotOwner = {};
  const targetObserverListsMap: ObserverListsMap = new WeakMap();
  const proxyCallbacks: Partial<ProxyCallbacks> = {};
  const trackingContext: TrackingContext = {
    currentConsumer: null,
    currentDependencyCollector: null,
  };
  const trackingIsInProgress = () =>
    trackingContext.currentConsumer !== null || trackingContext.currentDependencyCollector !== null;
  const activeArrayIterations: {
    target: ConsumerTarget;
    consumer: ConsumerRecord | null;
    collector: DependencyCollector | null;
  }[] = [];
  const rootTargetReference: { current: ConsumerTarget | null } = { current: null };

  let persistHandle: PersistHandle | null = null;
  let hydrating = false;
  let currentActionLabel: string | null = null;

  const rerenderQueue: ConsumerRecord[] = [];
  let computedRerenderQueue: ConsumerRecord[] | null = null;
  let batchingDepth = 0;
  let flushing = false;

  const storeListeners = new Set<StoreListener>();
  let storeDirty = false;
  let listenersFlushing = false;

  let version = 0;
  const dirtyTargets = new Set<ConsumerTarget>();
  let snapshotNodeCache = new WeakMap<{}, unknown>();
  let snapshotSharingActive = false;

  const flushStoreListeners = () => {
    if (flushing || listenersFlushing || !storeDirty || batchingDepth > 0) return;
    listenersFlushing = true;
    try {
      while (storeDirty) {
        storeDirty = false;
        for (const listener of Array.from(storeListeners)) {
          try {
            listener.callback();
          } catch (error) {
            queueMicrotask(() => {
              throw error;
            });
          }
        }
      }
    } finally {
      listenersFlushing = false;
    }
  };

  const flushQueue = () => {
    if (flushing) return;
    flushing = true;
    let firstError: unknown;
    let hasError = false;
    try {
      let computedIndex = 0;
      let consumerIndex = 0;
      // Drain computed work before each ordinary consumer while preserving FIFO order within each queue.
      let hasQueuedWork =
        rerenderQueue.length > 0 || (computedRerenderQueue !== null && computedRerenderQueue.length > 0);
      while (hasQueuedWork) {
        const hasComputedWork =
          computedRerenderQueue !== null && computedIndex < computedRerenderQueue.length;
        let consumer: ConsumerRecord | undefined;
        if (hasComputedWork && computedRerenderQueue !== null) {
          consumer = computedRerenderQueue[computedIndex];
          computedIndex++;
        } else {
          consumer = rerenderQueue[consumerIndex];
          consumerIndex++;
        }
        if (consumer !== undefined) {
          consumer.queued = false;
          if (consumer.active) {
            try {
              consumer.rerender();
            } catch (error) {
              if (!hasError) {
                hasError = true;
                firstError = error;
              }
            }
          }
        }
        hasQueuedWork =
          consumerIndex < rerenderQueue.length ||
          (computedRerenderQueue !== null && computedIndex < computedRerenderQueue.length);
      }
    } finally {
      computedRerenderQueue = null;
      rerenderQueue.length = 0;
      flushing = false;
    }
    if (storeDirty) flushStoreListeners();
    if (hasError) throw firstError;
  };

  const scheduleRerender = (consumer: ConsumerRecord) => {
    if (consumer.active && !consumer.queued) {
      consumer.queued = true;
      if (consumer.deliveryClass === "computed") {
        (computedRerenderQueue ??= []).push(consumer);
      } else {
        rerenderQueue.push(consumer);
      }

      if (batchingDepth === 0 && !flushing) {
        flushQueue();
      }
    }
  };

  const startBatch = () => {
    batchingDepth++;
  };

  const endBatch = () => {
    batchingDepth--;
    if (
      batchingDepth === 0 &&
      (rerenderQueue.length > 0 || (computedRerenderQueue !== null && computedRerenderQueue.length > 0))
    ) {
      flushQueue();
    }
    if (batchingDepth === 0 && !flushing && storeDirty) flushStoreListeners();
  };

  const collectionMutationBatch = {
    owner: {},
    start: startBatch,
    complete: () => {
      if (!hydrating) persistHandle?.schedulePersist();
      endBatch();
    },
  };

  const markTargetChanged = (target: ConsumerTarget) => {
    version++;
    if (snapshotSharingActive) {
      dirtyTargets.add(target);
      if (dirtyTargets.size > SNAPSHOT_DIRT_LIMIT) {
        dirtyTargets.clear();
        snapshotNodeCache = new WeakMap();
      }
    }
    if (storeListeners.size > 0) storeDirty = true;
  };

  // Reuse a pruned list only while its observer-map slot still identifies it.
  const reviveObserverList = (observers: PropertyObserverList) => {
    let targetObservers = targetObserverListsMap.get(observers.target);
    if (targetObservers === undefined) {
      targetObservers = new Map();
      targetObserverListsMap.set(observers.target, targetObservers);
    } else if (targetObservers.has(observers.prop)) {
      return false;
    }
    targetObservers.set(observers.prop, observers);
    observers.pruned = false;
    return true;
  };

  const registerDependency = (consumer: ConsumerRecord, target: ConsumerTarget, prop: ConsumerTargetProp) => {
    if (!consumer.active) {
      throw new Error("statelift: cannot track dependencies for an inactive consumer");
    }

    if (consumer.retainingDependencies) {
      const retainedEdge = dependencyEdgeAt(consumer.dependencies, consumer.retainedDependencyCount);
      if (
        retainedEdge !== undefined &&
        retainedEdge.observers.target === target &&
        retainedEdge.observers.prop === prop
      ) {
        const observers = retainedEdge.observers;
        if (observers.tail !== retainedEdge) {
          detachObserverEdge(retainedEdge);
          const tail = observers.tail;
          if (tail === null) observers.head = retainedEdge;
          else {
            retainedEdge.previous = tail;
            tail.next = retainedEdge;
          }
          observers.tail = retainedEdge;
        }
        consumer.retainedDependencyCount++;
        return;
      }

      finishRetainedDependencies(consumer);
    }

    const dependencyCount = dependencyEdgeCount(consumer.dependencies);
    const replayEdge = dependencyEdgeAt(consumer.reusableEdges, dependencyCount);
    if (
      consumer.replayingStableDependencyPrefix &&
      replayEdge !== undefined &&
      replayEdge.observers.target === target &&
      replayEdge.observers.prop === prop &&
      (!replayEdge.observers.pruned || reviveObserverList(replayEdge.observers))
    ) {
      const observers = replayEdge.observers;
      const tail = observers.tail;
      if (tail === null) observers.head = replayEdge;
      else {
        replayEdge.previous = tail;
        tail.next = replayEdge;
      }
      observers.tail = replayEdge;
      replayEdge.dependencyIndex = dependencyCount;
      appendDependencyEdge(consumer, replayEdge);
      return;
    }

    if (consumer.replayingStableDependencyPrefix) {
      consumer.replayingStableDependencyPrefix = false;
    }

    let targetObservers = targetObserverListsMap.get(target);
    let observers = targetObservers?.get(prop);
    if (!targetObservers) {
      targetObservers = new Map();
      targetObserverListsMap.set(target, targetObservers);
    }
    if (!observers) {
      observers = {
        target,
        prop,
        head: null,
        tail: null,
        ownerTargetMap: targetObserverListsMap,
        pruned: false,
      };
      targetObservers.set(prop, observers);
    }

    if (consumer.dependencies === null && consumer.observedLists === null) {
      const edge = replayEdge ?? {
        observers,
        consumer,
        dependencyIndex: 0,
        previous: null,
        next: null,
      };
      attachObserverEdge(consumer, edge, observers);
      return;
    }

    const dependencies = consumer.dependencies;
    if (dependencies !== null && !Array.isArray(dependencies) && dependencies.observers === observers) {
      return;
    }

    const observedLists = getObservedLists(consumer);
    if (observedLists.has(observers)) return;
    observedLists.add(observers);

    const edge = replayEdge ?? {
      observers,
      consumer,
      dependencyIndex: 0,
      previous: null,
      next: null,
    };
    attachObserverEdge(consumer, edge, observers);
  };

  const trackPropertyDependency = (target: ConsumerTarget, prop: ConsumerTargetProp) => {
    const consumer = trackingContext.currentConsumer;
    const collector = trackingContext.currentDependencyCollector;
    if (consumer === null && collector === null) return;
    if (Array.isArray(target) && (prop === "length" || isArrayIndex(prop))) {
      for (let index = activeArrayIterations.length - 1; index >= 0; index--) {
        const iteration = activeArrayIterations[index];
        if (
          iteration?.target === target &&
          iteration.consumer === consumer &&
          iteration.collector === collector
        ) {
          return;
        }
      }
    }
    if (consumer === null) {
      collector?.(target, prop);
    } else {
      registerDependency(consumer, target, prop);
    }
  };

  const trackOwnKeysDependency = (target: ConsumerTarget) => {
    const consumer = trackingContext.currentConsumer;
    if (consumer === null) {
      trackingContext.currentDependencyCollector?.(target, OWNKEYS_DEPENDENCY);
    } else {
      registerDependency(consumer, target, OWNKEYS_DEPENDENCY);
    }
  };

  let trackingCallbacksEnabled = false;
  const enableTrackingCallbacks = () => {
    if (trackingCallbacksEnabled) return;
    trackingCallbacksEnabled = true;
    proxyCallbacks.get = trackPropertyDependency;
    proxyCallbacks.ownKeys = trackOwnKeysDependency;
  };

  const registerConsumer = (consumer: ConsumerRecord) => {
    if (!trackingCallbacksEnabled) enableTrackingCallbacks();
    consumer.active = true;
    consumer.queued = false;

    return () => {
      if (!consumer.active) return;
      consumer.active = false;
      const dependencies = consumer.dependencies;
      if (Array.isArray(dependencies)) {
        for (const edge of dependencies) detachObserverEdge(edge);
      } else if (dependencies !== null) {
        detachObserverEdge(dependencies);
      }
      consumer.dependencies = null;
      consumer.reusableEdges = null;
      consumer.observedLists?.clear();
      consumer.replayingStableDependencyPrefix = false;
      consumer.retainingDependencies = false;
      consumer.retainedDependencyCount = 0;
    };
  };

  const scheduleObserverList = (observers: PropertyObserverList, target: ConsumerTarget) => {
    const trackingInProgress = trackingIsInProgress();
    let edge = observers.head;
    while (edge !== null) {
      const consumer = edge.consumer;
      if (!consumer.active) {
        throw new Error("statelift: an inactive consumer is still registered for updates");
      }
      if (!trackingInProgress || observerEdgeIsActive(edge)) {
        consumer.revoke(target);
        scheduleRerender(consumer);
      }
      edge = edge.next;
    }
  };

  const notifyOwnKeysConsumers = (target: ConsumerTarget) => {
    markTargetChanged(target);
    const observers = targetObserverListsMap.get(target)?.get(OWNKEYS_DEPENDENCY);
    if (!observers || observers.head === null) return;

    startBatch();
    try {
      scheduleObserverList(observers, target);
    } finally {
      endBatch();
    }
  };

  const notifyArrayIterationConsumers = (target: ConsumerTarget) => {
    const observers = targetObserverListsMap.get(target)?.get(ARRAY_ITERATION_DEPENDENCY);
    if (!observers || observers.head === null) return;

    startBatch();
    try {
      scheduleObserverList(observers, target);
    } finally {
      endBatch();
    }
  };

  const notifyDelete = (target: ConsumerTarget, prop: ConsumerTargetProp) => {
    markTargetChanged(target);
    const observers = targetObserverListsMap.get(target)?.get(prop);

    if (observers?.head) {
      startBatch();
      try {
        scheduleObserverList(observers, target);
      } finally {
        endBatch();
      }
    }

    notifyOwnKeysConsumers(target);
  };

  const notifySet = (target: ConsumerTarget, prop: ConsumerTargetProp, isNewProperty: boolean) => {
    markTargetChanged(target);
    const observers = targetObserverListsMap.get(target)?.get(prop);

    if (!observers || observers.head === null) {
      if (isNewProperty) notifyOwnKeysConsumers(target);
      return;
    }

    const head = observers.head;
    if (head === observers.tail && trackingIsInProgress() && !observerEdgeIsActive(head)) {
      if (isNewProperty) notifyOwnKeysConsumers(target);
      return;
    }
    if (head === observers.tail && head.consumer.active && !flushing) {
      const consumer = head.consumer;
      consumer.revoke(target);
      scheduleRerender(consumer);
      if (isNewProperty) notifyOwnKeysConsumers(target);
      return;
    }

    startBatch();
    try {
      scheduleObserverList(observers, target);
    } finally {
      endBatch();
    }

    if (isNewProperty) notifyOwnKeysConsumers(target);
  };

  const registerListener = (listener: StoreListener) => {
    storeListeners.add(listener);
    return () => {
      storeListeners.delete(listener);
    };
  };

  const notifyTargetCoarse = (target: ConsumerTarget) => {
    markTargetChanged(target);
    const targetObservers = targetObserverListsMap.get(target);
    if (!targetObservers) return;

    startBatch();
    try {
      const seen = new Set<ConsumerRecord>();
      const trackingInProgress = trackingIsInProgress();
      for (const observers of targetObservers.values()) {
        let edge = observers.head;
        while (edge !== null) {
          const currentEdge = edge;
          const consumer = currentEdge.consumer;
          edge = currentEdge.next;
          if (trackingInProgress && !observerEdgeIsActive(currentEdge)) continue;
          if (seen.has(consumer)) continue;
          seen.add(consumer);
          consumer.revoke(target);
          scheduleRerender(consumer);
        }
      }
    } finally {
      endBatch();
    }
  };

  const computedRegistry = new WeakMap<ConsumerTarget, Map<ConsumerTargetProp, ComputedCell>>();
  const allComputedCells = new Set<ComputedCell>();
  let hasComputedCells = false;
  const computedEvaluationStack: ComputedCell[] = [];

  const evictComputed = (target: ConsumerTarget, prop: ConsumerTargetProp) => {
    const cells = computedRegistry.get(target);
    const cell = cells?.get(prop);
    if (!cells || !cell) return;
    cells.delete(prop);
    if (cells.size === 0) computedRegistry.delete(target);
    allComputedCells.delete(cell);
    cell.unregister();
    hasComputedCells = allComputedCells.size > 0;
    if (!hasComputedCells) proxyCallbacks.resolveComputed = undefined;
  };

  let cellSweepScheduled = false;
  // Sweep only cells unreachable from the root so aliased subtrees stay live.
  const scheduleCellSweep = () => {
    if (cellSweepScheduled || allComputedCells.size === 0) return;
    cellSweepScheduled = true;
    queueMicrotask(() => {
      cellSweepScheduled = false;
      const reachable = new Set<ConsumerTarget>();
      const root = rootTargetReference.current;
      if (root === null) {
        throw new Error("statelift: store initialization did not complete before computed cleanup");
      }
      const stack: unknown[] = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        const target = unwrapProxy(node, true);
        if (reachable.has(target)) continue;
        reachable.add(target);
        const cells = computedRegistry.get(target);
        if (cells !== undefined) {
          for (const cell of cells.values()) {
            if (cell.targetProxy !== undefined && cell.value !== null && typeof cell.value === "object") {
              stack.push(cell.value);
            }
          }
        }
        for (const key of Reflect.ownKeys(target)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (!descriptor) continue;
          // Reachability checks must not execute getters.
          if (!Object.hasOwn(descriptor, "value")) continue;
          const child = descriptor.value as unknown;
          if (child && typeof child === "object") stack.push(child);
        }
      }
      for (const cell of Array.from(allComputedCells)) {
        if (!reachable.has(cell.target)) {
          evictComputed(cell.target, cell.prop);
        }
      }
    });
  };

  const evaluateComputed = (cell: ComputedCell, targetProxy: {}) => {
    if (cell.evaluating) {
      const requester = computedEvaluationStack[computedEvaluationStack.length - 1];
      throw new Error(
        `statelift: computed cycle detected between "${String(cell.prop)}" and "${String(requester?.prop ?? cell.prop)}"`,
      );
    }
    cell.evaluating = true;
    computedEvaluationStack.push(cell);
    const previousConsumer = trackingContext.currentConsumer;
    const previousCollector = trackingContext.currentDependencyCollector;
    trackingContext.currentConsumer = cell.consumer;
    trackingContext.currentDependencyCollector = null;
    refreshConsumerDependencies(cell.consumer);
    try {
      cell.value = cell.getter.call(targetProxy);
      cell.dirty = false;
    } finally {
      trackingContext.currentConsumer = previousConsumer;
      trackingContext.currentDependencyCollector = previousCollector;
      computedEvaluationStack.pop();
      cell.evaluating = false;
    }
  };

  const invalidateComputed = (cell: ComputedCell) => {
    const wasDirty = cell.dirty;
    cell.dirty = true;
    if (wasDirty || cell.targetProxy === undefined) return;

    const previous = cell.value;
    try {
      evaluateComputed(cell, cell.targetProxy);
    } catch (error) {
      // Preserve the previous value and retry after surfacing the error.
      queueMicrotask(() => {
        throw error;
      });
      return;
    }
    if (!Object.is(cell.value, previous)) {
      startBatch();
      try {
        notifySet(cell.target, cell.prop, false);
        if (Array.isArray(cell.target) && isArrayIndex(cell.prop)) {
          notifyArrayIterationConsumers(cell.target);
        }
      } finally {
        endBatch();
      }
    }
  };

  const resolveComputedCells = (target: ConsumerTarget, prop: ConsumerTargetProp, targetProxy: {}) => {
    const cell = computedRegistry.get(target)?.get(prop);
    if (!cell) return undefined;
    cell.targetProxy = targetProxy;
    if (cell.dirty) {
      evaluateComputed(cell, targetProxy);
    }
    return { value: cell.value };
  };

  const createComputedCell = (target: ConsumerTarget, prop: ConsumerTargetProp, getter: () => unknown) => {
    evictComputed(target, prop);
    let cells = computedRegistry.get(target);
    if (!cells) {
      cells = new Map();
      computedRegistry.set(target, cells);
    }
    const cell: ComputedCell = {
      consumer: createConsumerRecord(
        {
          rerender: () => invalidateComputed(cell),
          revoke: () => {},
        },
        "computed",
      ),
      target,
      prop,
      getter,
      value: undefined,
      dirty: true,
      evaluating: false,
      targetProxy: undefined,
      unregister: () => {},
    };
    cell.unregister = registerConsumer(cell.consumer);
    cells.set(prop, cell);
    allComputedCells.add(cell);
    if (!hasComputedCells) {
      hasComputedCells = true;
      proxyCallbacks.resolveComputed = resolveComputedCells;
    }
  };

  const reconcileComputed = (target: ConsumerTarget, prop: ConsumerTargetProp) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, prop);
    const getter = descriptor?.get;
    const eligible = getter && !descriptor.set && !isUncachedGetter(getter);
    const current = computedRegistry.get(target)?.get(prop);
    if (eligible && current?.getter === getter) return;
    evictComputed(target, prop);
    if (!eligible) return;
    createComputedCell(target, prop, getter);
  };

  const scanTargetForComputeds = (target: ConsumerTarget) => {
    for (const prop of Reflect.ownKeys(target)) {
      reconcileComputed(target, prop);
    }
  };

  const descriptorChangesPropertyRead = (mutation: DescriptorMutation) => {
    const { before, after } = mutation;
    if (before === undefined) return true;
    const beforeIsData = Object.hasOwn(before, "value");
    const afterIsData = Object.hasOwn(after, "value");
    if (beforeIsData !== afterIsData) return true;
    if (beforeIsData) return !Object.is(before.value, after.value);
    return before.get !== after.get || before.set !== after.set;
  };

  const descriptorChangesOwnKeys = (mutation: DescriptorMutation) =>
    mutation.before === undefined || mutation.before.enumerable !== mutation.after.enumerable;

  const notifyRootPropertySet = (
    target: ConsumerTarget,
    prop: ConsumerTargetProp,
    value: unknown,
    oldValue: unknown,
  ) => {
    if (
      hasComputedCells &&
      typeof oldValue === "object" &&
      oldValue !== null &&
      !Object.is(oldValue, value)
    ) {
      scheduleCellSweep();
    }
    if (!hydrating) persistHandle?.schedulePersist();
    notifySet(target, prop, false);
    if (storeDirty) flushStoreListeners();
  };

  let trackedArrayMethodCache:
    | WeakMap<
        unknown[],
        Map<string, { method: (...args: unknown[]) => unknown; wrapped: (...args: unknown[]) => unknown }>
      >
    | undefined;
  const wrapArrayIteration = (
    target: unknown[],
    prop: string,
    method: (...args: unknown[]) => unknown,
    wrapElement: IterationElementWrapper,
    targetProxy: {} | undefined,
  ) => {
    if (!ARRAY_ITERATION_METHODS.has(prop) || method !== Reflect.get(Array.prototype, prop)) {
      return undefined;
    }
    let targetMethods = trackedArrayMethodCache?.get(target);
    if (targetMethods === undefined) {
      targetMethods = new Map();
      (trackedArrayMethodCache ??= new WeakMap()).set(target, targetMethods);
    }
    const cached = targetMethods.get(prop);
    if (cached?.method === method) return cached.wrapped;

    const wrapped = function (this: unknown, ...args: unknown[]) {
      const receiverTarget = typeof this === "object" && this !== null ? unwrapProxy(this, true) : this;
      if (receiverTarget !== target) {
        return Reflect.apply(method, this, args);
      }
      const consumer = trackingContext.currentConsumer;
      const collector = trackingContext.currentDependencyCollector;
      const tracked = consumer !== null || collector !== null;
      if (tracked) {
        if (consumer === null) {
          collector?.(target, ARRAY_ITERATION_DEPENDENCY);
        } else {
          registerDependency(consumer, target, ARRAY_ITERATION_DEPENDENCY);
        }
      }

      const callback = args[0];
      if (
        this === targetProxy &&
        targetProxy !== undefined &&
        isFunction(callback) &&
        ITERATION_FAST_PATH_METHODS.has(prop) &&
        computedRegistry.get(target) === undefined &&
        (!SPECIES_CREATING_METHODS.has(prop) || hasDefaultArraySpecies(target))
      ) {
        if (tracked && SPECIES_CREATING_METHODS.has(prop)) {
          // Preserve ArraySpeciesCreate's constructor dependency.
          if (consumer === null) collector?.(target, "constructor");
          else registerDependency(consumer, target, "constructor");
        }
        if (!tracked) {
          return runIterationFastPath({
            target,
            method: prop,
            callback,
            thisArg: args[1],
            receiver: targetProxy,
            wrapElement,
          });
        }
        activeArrayIterations.push({ target, consumer, collector });
        try {
          return runIterationFastPath({
            target,
            method: prop,
            callback,
            thisArg: args[1],
            receiver: targetProxy,
            wrapElement,
          });
        } finally {
          activeArrayIterations.pop();
        }
      }

      if (!tracked) {
        return Reflect.apply(method, this, args);
      }
      activeArrayIterations.push({ target, consumer, collector });
      try {
        return Reflect.apply(method, this, args);
      } finally {
        activeArrayIterations.pop();
      }
    };
    targetMethods.set(prop, { method, wrapped });
    return wrapped;
  };

  const proxyCallbackImplementations: Partial<ProxyCallbacks> = {
    get: undefined,
    ownKeys: undefined,
    setExistingProperty: (target, prop) => {
      if (hasComputedCells) return false;
      const collectionMutation = joinCollectionMutation(target, collectionMutationBatch);
      if (!collectionMutation && !hydrating) persistHandle?.schedulePersist();
      notifySet(target, prop, false);
      if (!collectionMutation && storeDirty) flushStoreListeners();
      return true;
    },
    set: ({ target, prop, value, isNewProperty, oldArrayLength, newArrayLength, oldValue }: SetMutation) => {
      const collectionMutation = joinCollectionMutation(target, collectionMutationBatch);
      if (
        hasComputedCells &&
        typeof oldValue === "object" &&
        oldValue !== null &&
        !Object.is(oldValue, value)
      ) {
        scheduleCellSweep();
      }
      if (!collectionMutation && !hydrating) persistHandle?.schedulePersist();
      startBatch();
      try {
        if (oldArrayLength !== undefined && newArrayLength !== undefined && newArrayLength < oldArrayLength) {
          for (let i = newArrayLength; i < oldArrayLength; i++) {
            notifySet(target, String(i), false);
          }
        }
        notifySet(target, prop, isNewProperty);
        if (
          oldArrayLength !== undefined &&
          newArrayLength !== undefined &&
          newArrayLength !== oldArrayLength &&
          prop !== "length"
        ) {
          notifySet(target, "length", false);
        }
        if (oldArrayLength !== undefined && newArrayLength !== undefined && newArrayLength < oldArrayLength) {
          notifyOwnKeysConsumers(target);
        }
        if (oldArrayLength !== undefined && (prop === "length" || isArrayIndex(prop))) {
          notifyArrayIterationConsumers(target);
        }
      } finally {
        endBatch();
      }
    },
    defineProperty: (mutation) => {
      const { target, prop, before, after, oldArrayLength, newArrayLength } = mutation;
      const collectionMutation = joinCollectionMutation(target, collectionMutationBatch);
      reconcileComputed(target, prop);
      const oldValue = before && Object.hasOwn(before, "value") ? before.value : undefined;
      const newValue = Object.hasOwn(after, "value") ? after.value : undefined;
      if (
        hasComputedCells &&
        typeof oldValue === "object" &&
        oldValue !== null &&
        !Object.is(oldValue, newValue)
      ) {
        scheduleCellSweep();
      }

      if (!collectionMutation && !hydrating) persistHandle?.schedulePersist();
      let notified = false;
      startBatch();
      try {
        if (oldArrayLength !== undefined && newArrayLength !== undefined && newArrayLength < oldArrayLength) {
          for (let index = newArrayLength; index < oldArrayLength; index++) {
            notifySet(target, String(index), false);
          }
          notified = true;
        }
        if (descriptorChangesPropertyRead(mutation)) {
          notifySet(target, prop, before === undefined);
          notified = true;
        }
        if (
          oldArrayLength !== undefined &&
          newArrayLength !== undefined &&
          newArrayLength !== oldArrayLength &&
          prop !== "length"
        ) {
          notifySet(target, "length", false);
          notified = true;
        }
        if (
          descriptorChangesOwnKeys(mutation) ||
          (oldArrayLength !== undefined && newArrayLength !== undefined && newArrayLength < oldArrayLength)
        ) {
          if (before !== undefined || !descriptorChangesPropertyRead(mutation)) {
            notifyOwnKeysConsumers(target);
          }
          notified = true;
        }
        if (!notified) markTargetChanged(target);
        if (notified && oldArrayLength !== undefined && (prop === "length" || isArrayIndex(prop))) {
          notifyArrayIterationConsumers(target);
        }
      } finally {
        endBatch();
      }
    },
    deleteProperty: (target, prop, oldValue) => {
      const collectionMutation = joinCollectionMutation(target, collectionMutationBatch);
      evictComputed(target, prop);
      if (hasComputedCells && typeof oldValue === "object" && oldValue !== null) {
        scheduleCellSweep();
      }
      if (!collectionMutation && !hydrating) persistHandle?.schedulePersist();
      startBatch();
      try {
        notifyDelete(target, prop);
        if (Array.isArray(target) && isArrayIndex(prop)) {
          notifyArrayIterationConsumers(target);
        }
      } finally {
        endBatch();
      }
    },
    onWrap: scanTargetForComputeds,
    wrapArrayIteration,
    arrayMethodComplete: (target, _method, completion) => {
      if (hasComputedCells && completion.mayDetachElements) scheduleCellSweep();
      if (!hydrating) persistHandle?.schedulePersist();
      startBatch();
      try {
        if (completion.coarse) {
          notifyTargetCoarse(target);
        } else {
          for (const op of completion.ops) {
            if (op.type === "set") {
              notifySet(target, op.prop, op.isNewProperty);
            } else {
              notifyDelete(target, op.prop);
            }
          }
          notifyArrayIterationConsumers(target);
        }
      } finally {
        endBatch();
      }
    },
  };
  Object.assign(proxyCallbacks, proxyCallbackImplementations);

  const {
    state,
    target: rootTarget,
    createView,
  } = createStoreRootProxy(builder, {
    callbacks: proxyCallbacks,
    setRootProperty: notifyRootPropertySet,
    strict: options?.strict,
  });
  rootTargetReference.current = rootTarget;

  // Root descriptors bypass proxy traps during construction.
  scanTargetForComputeds(rootTarget);
  rawTargetCache.set(state, rootTarget);

  const applyImportedData = (data: unknown, warnContext?: string) => {
    if (data === null || typeof data !== "object") return;
    hydrating = true;
    startBatch();
    try {
      validateMergeData(state, data);
      deepMerge(state, data, warnContext);
    } finally {
      // Clear hydrating before delivery so listener mutations persist.
      hydrating = false;
      endBatch();
    }
  };
  const buildSnapshot = () => {
    snapshotSharingActive = true;
    const value = snapshotTree(rootTarget, {
      freeze: IS_DEV,
      sharing: {
        isDirty: (target) => dirtyTargets.has(target),
        cache: snapshotNodeCache,
        owner: snapshotOwner,
      },
    });
    dirtyTargets.clear();
    return value;
  };
  const runWithActionLabel = <R>(label: string, fn: () => R): R => {
    if (currentActionLabel !== null) return fn();
    currentActionLabel = label;
    try {
      return fn();
    } finally {
      currentActionLabel = null;
    }
  };

  const internals: StoreInternals<T> = {
    state,
    trackingContext,
    ensureTrackingCallbacksEnabled: enableTrackingCallbacks,
    createConsumerView: createView,
    trackContextDependency: trackPropertyDependency,
    trackContextOwnKeys: trackOwnKeysDependency,
    hasComputedCell: (target) => computedRegistry.get(target) !== undefined,
    registerConsumer,
    registerDependency,
    refreshConsumerDependencies,
    registerListener,
    getVersion: () => version,
    startBatch,
    endBatch,
    hydrate: (data) => {
      applyImportedData(data, IS_DEV ? "hydrate" : undefined);
    },
    getActionLabel: () => currentActionLabel,
    runWithActionLabel,
    buildSnapshot,
  };
  stateToStoreInternalsMap.set(state, internals);
  snapshotOwnerMap.set(state, snapshotOwner);

  if (options?.persist !== undefined) {
    persistHandle = initPersist<T>({
      options: normalizePersistOptions(options.persist),
      state,
      getSnapshot: () => snapshot({ state }),
      applyData: (data) => applyImportedData(data),
    });
    if (persistHandle.activation === "immediate") persistHandle.activate();
  }

  return { state };
};

/** Creates a reactive store from a plain record or builder. */
type StoreRoot<T> =
  T extends (...args: never[]) => unknown ? never
  : T extends readonly unknown[] ? never
  : T extends Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object> ? never
  : T extends ArrayBuffer | ArrayBufferView | Date | Promise<unknown> | RegExp | URL | URLSearchParams ? never
  : T extends ProxyMap<infer _Key, infer _Value> ? never
  : T extends ProxySet<infer _Value> ? never
  : T extends object ? T
  : never;

type CreateStoreFromBuilder = <T extends object>(
  builder: (root: T) => StoreRoot<T>,
  options?: StoreOptions<T>,
) => Store<T>;
type CreateStoreFromTarget = <T extends object>(target: StoreRoot<T>, options?: StoreOptions<T>) => Store<T>;
type CreateStore = CreateStoreFromBuilder & CreateStoreFromTarget;

export const createStore: CreateStore = <T extends object>(
  target: StoreRoot<T> | ((root: T) => StoreRoot<T>),
  options?: StoreOptions<T>,
) => {
  const builder = typeof target === "function" ? target : () => target;
  return createStoreFromBuilder(builder, options);
};

const rawOf = (proxied: {}) => {
  let raw = rawTargetCache.get(proxied);
  if (raw === undefined) {
    raw = unwrapProxy(proxied, true);
    rawTargetCache.set(proxied, raw);
  }
  return raw;
};

// A pre-revoked proxy preserves access errors for destroyed lazy consumers.
const REVOKED_PROXY: {} = (() => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
})();
const trackConsumerValue = <T extends {}, R>(
  tracking: ConsumerTracking<T>,
  read: (state: T) => R,
  mode: "preserve-dependencies" | "refresh-dependencies" = "refresh-dependencies",
): R => {
  const { store, storeInternals, trackingContext, consumerRecord, trackDepth, collectDependency } = tracking;
  const outermostTrack = trackDepth === 0;
  const refreshDependencies = outermostTrack && mode === "refresh-dependencies";
  if (refreshDependencies) {
    tracking.iteratedArrays = null;
    if (consumerRecord.active) {
      storeInternals.refreshConsumerDependencies(consumerRecord, "retain-links");
    } else {
      tracking.pendingDependencyTarget = null;
      tracking.pendingDependencies = null;
    }
  }
  tracking.trackDepth++;
  if (
    consumerRecord.active &&
    trackingContext.currentConsumer === null &&
    trackingContext.currentDependencyCollector === null
  ) {
    trackingContext.currentConsumer = consumerRecord;
    try {
      return read(store.state);
    } finally {
      if (refreshDependencies) finishRetainedDependencies(consumerRecord);
      tracking.trackDepth--;
      trackingContext.currentConsumer = null;
    }
  }

  const previousConsumer = trackingContext.currentConsumer;
  const previousCollector = trackingContext.currentDependencyCollector;
  if (consumerRecord.active) {
    trackingContext.currentConsumer = consumerRecord;
    trackingContext.currentDependencyCollector = null;
  } else {
    trackingContext.currentConsumer = null;
    trackingContext.currentDependencyCollector = collectDependency;
  }
  try {
    return read(store.state);
  } finally {
    if (refreshDependencies) finishRetainedDependencies(consumerRecord);
    if (outermostTrack && !consumerRecord.active) {
      tracking.observedVersion = storeInternals.getVersion();
    }
    tracking.trackDepth--;
    trackingContext.currentConsumer = previousConsumer;
    trackingContext.currentDependencyCollector = previousCollector;
  }
};

const collectConsumerDependency = <T extends {}>(
  tracking: ConsumerTracking<T>,
  target: ConsumerTarget,
  prop: ConsumerTargetProp,
) => {
  const observedVersion = tracking.storeInternals.getVersion();
  if (tracking.pendingDependencyTarget === null) {
    tracking.pendingDependencyTarget = target;
    tracking.pendingDependencyProp = prop;
    tracking.pendingDependencyVersion = observedVersion;
    return;
  }
  if (tracking.pendingDependencies === null) {
    if (tracking.pendingDependencyTarget === target && tracking.pendingDependencyProp === prop) {
      tracking.pendingDependencyVersion = observedVersion;
      return;
    }
    const firstProps = new Map([[tracking.pendingDependencyProp, tracking.pendingDependencyVersion]]);
    tracking.pendingDependencies = new Map([[tracking.pendingDependencyTarget, firstProps]]);
  }
  let props = tracking.pendingDependencies.get(target);
  if (props === undefined) {
    props = new Map();
    tracking.pendingDependencies.set(target, props);
  }
  props.set(prop, observedVersion);
  if (prop === ARRAY_ITERATION_DEPENDENCY) {
    for (const pendingProp of props.keys()) {
      if (pendingProp === "length" || isArrayIndex(pendingProp)) {
        props.set(pendingProp, observedVersion);
      }
    }
  }
};

const createConsumerWithTracking = <T extends {}>(
  store: Store<T>,
  onRerender: () => void,
  options?: { deferRegistration?: boolean },
): CreatedConsumer<T> => {
  let revocable: { proxy: {}; revoke: () => void } | null = null;
  let consumerDestroyed = false;
  let consumerActive = false;
  let unregisterConsumer: (() => void) | null = null;
  let selectedRawTarget: ConsumerTarget | null = null;
  const viewReference: { current: DeepProxyView | null } = { current: null };

  const storeInternals = requireStoreInternals(store);
  const trackingContext = storeInternals.trackingContext;
  storeInternals.ensureTrackingCallbacksEnabled();

  const revokeCachedProxy = (target: {}) => {
    const currentView = viewReference.current;
    if (currentView === null) {
      throw new Error("statelift: consumer view initialization did not complete before invalidation");
    }
    currentView.invalidate(target);
    if (selectedRawTarget !== null && selectedRawTarget !== target) {
      currentView.invalidate(selectedRawTarget);
    }
  };
  const consumerRecord = createConsumerRecord(
    {
      rerender: onRerender,
      revoke: revokeCachedProxy,
    },
    "ordinary",
  );
  const tracking: ConsumerTracking<T> = {
    store,
    storeInternals,
    trackingContext,
    consumerRecord,
    pendingDependencyTarget: null,
    pendingDependencyProp: OWNKEYS_DEPENDENCY,
    pendingDependencyVersion: storeInternals.getVersion(),
    pendingDependencies: null,
    collectDependency: (target, prop) => collectConsumerDependency(tracking, target, prop),
    observedVersion: storeInternals.getVersion(),
    iteratedArrays: null,
    trackDepth: 0,
  };
  const { collectDependency } = tracking;

  const activate = () => {
    if (consumerActive) return;
    if (consumerDestroyed) throw new Error("statelift: cannot activate a destroyed consumer");
    const unregister = storeInternals.registerConsumer(consumerRecord);
    unregisterConsumer = unregister;
    consumerActive = true;
    try {
      const currentVersion = storeInternals.getVersion();
      const {
        pendingDependencyTarget,
        pendingDependencyProp,
        pendingDependencyVersion,
        pendingDependencies,
        observedVersion: observedConsumerVersion,
      } = tracking;
      let pendingDependenciesAreCurrent = true;
      if (pendingDependencyTarget !== null) {
        if (pendingDependencies === null) {
          storeInternals.registerDependency(consumerRecord, pendingDependencyTarget, pendingDependencyProp);
          pendingDependenciesAreCurrent = pendingDependencyVersion === currentVersion;
        } else {
          for (const [target, props] of pendingDependencies) {
            for (const [prop, observedVersion] of props) {
              storeInternals.registerDependency(consumerRecord, target, prop);
              if (observedVersion !== currentVersion) pendingDependenciesAreCurrent = false;
            }
          }
        }
      }
      const versionRace =
        pendingDependencyTarget === null ?
          observedConsumerVersion !== currentVersion
        : !pendingDependenciesAreCurrent;
      tracking.pendingDependencyTarget = null;
      tracking.pendingDependencies = null;
      if (versionRace) onRerender();
    } catch (error) {
      unregister();
      unregisterConsumer = null;
      consumerActive = false;
      throw error;
    }
  };

  const beginRead = () => {
    if (trackingContext.currentConsumer !== null || trackingContext.currentDependencyCollector !== null) {
      return false;
    }
    if (consumerActive) {
      trackingContext.currentConsumer = consumerRecord;
    } else {
      trackingContext.currentDependencyCollector = collectDependency;
    }
    return true;
  };
  const endRead = (claimed: boolean) => {
    if (!claimed) return;
    if (!consumerActive) tracking.observedVersion = storeInternals.getVersion();
    trackingContext.currentConsumer = null;
    trackingContext.currentDependencyCollector = null;
  };
  const arrayIterationCoversProperty = (target: ConsumerTarget, prop: ConsumerTargetProp) => {
    const { iteratedArrays } = tracking;
    return (
      Array.isArray(target) &&
      iteratedArrays?.has(target) === true &&
      (prop === "length" || isArrayIndex(prop))
    );
  };
  const trackGet = (target: ConsumerTarget, prop: ConsumerTargetProp, claimed: boolean) => {
    if (!claimed) {
      storeInternals.trackContextDependency(target, prop);
      return;
    }
    if (arrayIterationCoversProperty(target, prop)) return;
    if (consumerActive) {
      storeInternals.registerDependency(consumerRecord, target, prop);
    } else {
      collectDependency(target, prop);
    }
  };
  const trackOwnKeys = (target: ConsumerTarget, claimed: boolean) => {
    if (!claimed) {
      storeInternals.trackContextOwnKeys(target);
      return;
    }
    if (consumerActive) {
      storeInternals.registerDependency(consumerRecord, target, OWNKEYS_DEPENDENCY);
    } else {
      collectDependency(target, OWNKEYS_DEPENDENCY);
    }
  };
  let arrayMethodCache: WeakMap<
    ConsumerTarget,
    Map<
      string,
      {
        method: (...args: unknown[]) => unknown;
        viewProxy: {};
        wrapped: (...args: unknown[]) => unknown;
      }
    >
  > | null = null;
  const wrapIterationMethod = (
    target: unknown[],
    prop: string,
    method: (...args: unknown[]) => unknown,
    wrapElement: (target: unknown[], index: number, value: unknown) => unknown,
    viewProxy: {},
  ) => {
    let methods = arrayMethodCache?.get(target);
    if (methods === undefined) {
      methods = new Map();
      (arrayMethodCache ??= new WeakMap()).set(target, methods);
    }
    const cached = methods.get(prop);
    if (cached?.method === method) {
      // Keep the cached wrapper paired with the current view proxy.
      cached.viewProxy = viewProxy;
      return cached.wrapped;
    }
    const entry = {
      method,
      viewProxy,
      wrapped(this: unknown, ...args: unknown[]) {
        const ownerViewProxy = entry.viewProxy;
        const { iteratedArrays } = tracking;
        const ownerCall =
          trackingContext.currentConsumer === null &&
          trackingContext.currentDependencyCollector === null &&
          this === ownerViewProxy;
        if (ownerCall && (!consumerActive || iteratedArrays?.has(target) !== true)) {
          if (consumerActive) {
            storeInternals.registerDependency(consumerRecord, target, ARRAY_ITERATION_DEPENDENCY);
          } else {
            collectDependency(target, ARRAY_ITERATION_DEPENDENCY);
          }
          (tracking.iteratedArrays ??= new WeakSet()).add(target);
        }
        try {
          if (ownerCall) {
            const callback = args[0];
            if (
              isFunction(callback) &&
              ITERATION_FAST_PATH_METHODS.has(prop) &&
              !storeInternals.hasComputedCell(target) &&
              (!SPECIES_CREATING_METHODS.has(prop) || hasDefaultArraySpecies(target))
            ) {
              if (SPECIES_CREATING_METHODS.has(prop)) {
                if (consumerActive) {
                  storeInternals.registerDependency(consumerRecord, target, "constructor");
                } else {
                  collectDependency(target, "constructor");
                }
              }
              return runIterationFastPath({
                target,
                method: prop,
                callback,
                thisArg: args[1],
                receiver: ownerViewProxy,
                wrapElement,
              });
            }
          }
          return Reflect.apply(method, this, args);
        } finally {
          if (ownerCall && !consumerActive) {
            tracking.observedVersion = storeInternals.getVersion();
          }
        }
      },
    };
    methods.set(prop, entry);
    return entry.wrapped;
  };
  const view = storeInternals.createConsumerView({
    beginRead,
    endRead,
    trackGet,
    trackOwnKeys,
    wrapIterationMethod,
  });
  viewReference.current = view;

  if (!options?.deferRegistration) activate();

  const destroy = () => {
    if (consumerDestroyed) return;
    consumerDestroyed = true;
    unregisterConsumer?.();
    unregisterConsumer = null;
    consumerActive = false;
    tracking.pendingDependencyTarget = null;
    tracking.pendingDependencies = null;
    tracking.iteratedArrays = null;
    selectedRawTarget = null;
    revocable?.revoke();
  };

  const refreshDependencies = () => {
    tracking.iteratedArrays = null;
    if (consumerRecord.active) storeInternals.refreshConsumerDependencies(consumerRecord);
    else {
      tracking.pendingDependencyTarget = null;
      tracking.pendingDependencies = null;
    }
  };

  const track = <R>(fn: (state: T) => R) => trackConsumerValue(tracking, fn);

  const wrap = <V>(value: V) => {
    selectedRawTarget = null;
    if (typeof value !== "object" || value === null || value instanceof Function) return value;
    const selectedValue: object = value;
    const raw = rawOf(selectedValue);
    if (raw === selectedValue) return value;
    selectedRawTarget = raw;
    return view.wrap(selectedValue) as V;
  };

  const consumer: InternalConsumer<T> = {
    get proxy(): T {
      if (revocable === null) {
        if (consumerDestroyed) return REVOKED_PROXY as T;
        revocable = view.createRevocableRoot();
      }
      return revocable.proxy as T;
    },
    activate,
    destroy,
    refreshDependencies,
    track,
    [TRACK_WITH_PRESERVED_DEPENDENCIES]: (fn) => trackConsumerValue(tracking, fn, "preserve-dependencies"),
    wrap,
  };
  return { consumer, tracking };
};

export const createConsumer = <T extends {}>(
  store: Store<T>,
  onRerender: () => void,
  options?: { deferRegistration?: boolean },
): Consumer<T> => createConsumerWithTracking(store, onRerender, options).consumer;

export type UseStoreOptions<R> = {
  /** Comparison for selected values. Default: Object.is. */
  equalityFn?: (a: R, b: R) => boolean;
};

/** Batches state updates into one delivery cycle. */
export const batch = <T extends {}, R>(store: Store<T>, fn: () => R, options?: { label?: string }): R => {
  const internals = requireStoreInternals(store);

  const run = () => {
    internals.startBatch();
    try {
      return fn();
    } finally {
      internals.endBatch();
    }
  };
  if (options?.label === undefined) return run();
  return internals.runWithActionLabel(options.label, run);
};

/** Returns the current explicit batch label. */
export const getActionLabel = <T extends {}>(store: Store<T>): string | null => {
  const internals = stateToStoreInternalsMap.get(store.state);
  return internals ? internals.getActionLabel() : null;
};

type RestoreGraph = {
  restoredByIncoming: WeakMap<object, object>;
  preferredTargetByIncoming: WeakMap<object, object>;
  owner: object;
};

const createRestoreGraph = (owner: object) => ({
  restoredByIncoming: new WeakMap<object, object>(),
  preferredTargetByIncoming: new WeakMap<object, object>(),
  owner,
});

const isGetterOnly = (descriptor: PropertyDescriptor | undefined) =>
  descriptor?.get !== undefined && descriptor.set === undefined;

const inheritedPropertyDescriptor = (
  target: object,
  key: string | symbol,
): PropertyDescriptor | undefined => {
  let prototype = Reflect.getPrototypeOf(target);
  while (prototype !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
    if (descriptor !== undefined) return descriptor;
    prototype = Reflect.getPrototypeOf(prototype);
  }
  return undefined;
};

const assertCanAssignStateProperty = (target: object, key: string | symbol) => {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (descriptor !== undefined) {
    if (Object.hasOwn(descriptor, "value") ? descriptor.writable !== true : descriptor.set === undefined) {
      throw new TypeError(`statelift: cannot restore non-writable property "${String(key)}"`);
    }
    return;
  }

  if (Array.isArray(target) && isArrayIndex(key) && Number(key) >= target.length) {
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(target, "length");
    if (lengthDescriptor?.writable !== true) {
      throw new TypeError(`statelift: cannot restore array index "${key}" with a non-writable length`);
    }
  }

  if (key !== "__proto__") {
    const inherited = inheritedPropertyDescriptor(target, key);
    if (inherited !== undefined) {
      if (!Object.hasOwn(inherited, "value")) {
        if (inherited.set === undefined) {
          throw new TypeError(`statelift: cannot restore getter-only property "${String(key)}"`);
        }
        return;
      }
      if (inherited.writable !== true) {
        throw new TypeError(`statelift: cannot restore inherited non-writable property "${String(key)}"`);
      }
    }
  }

  if (!Object.isExtensible(target)) {
    throw new TypeError(`statelift: cannot add property "${String(key)}" to non-extensible state`);
  }
};

const assertCanDeleteStateProperty = (key: string | symbol, descriptor: PropertyDescriptor) => {
  if (descriptor.configurable === false) {
    throw new TypeError(`statelift: cannot delete non-configurable property "${String(key)}" during restore`);
  }
};

const assertCanRestoreEnumerability = (
  key: string | symbol,
  targetDescriptor: PropertyDescriptor | undefined,
  incomingDescriptor: PropertyDescriptor,
) => {
  if (
    targetDescriptor !== undefined &&
    Object.hasOwn(targetDescriptor, "value") &&
    targetDescriptor.enumerable !== incomingDescriptor.enumerable &&
    targetDescriptor.configurable === false
  ) {
    throw new TypeError(
      `statelift: cannot restore enumerability of non-configurable property "${String(key)}"`,
    );
  }
};

const shouldRestoreProperty = (
  targetValue: unknown,
  restoredValue: unknown,
  targetDescriptor: PropertyDescriptor | undefined,
  incomingDescriptor: PropertyDescriptor,
) => {
  if (targetDescriptor === undefined) return true;
  if (!sameAppliedValue(targetValue, restoredValue)) return true;
  return (
    Object.hasOwn(targetDescriptor, "value") && targetDescriptor.enumerable !== incomingDescriptor.enumerable
  );
};

const restoreArrayTarget = (targetValue: unknown, incomingValue: object, graph: RestoreGraph) => {
  if (Array.isArray(targetValue) && !Object.isFrozen(targetValue)) return targetValue;
  const origin = getSnapshotOrigin(incomingValue, graph.owner);
  if (Array.isArray(origin) && !Object.isFrozen(origin)) return origin;
  const preferredTarget = graph.preferredTargetByIncoming.get(incomingValue);
  return Array.isArray(preferredTarget) && !Object.isFrozen(preferredTarget) ? preferredTarget : [];
};

const restoreRecordTarget = (targetValue: unknown, incomingValue: object, graph: RestoreGraph) => {
  if (isMergeableStateRecord(targetValue)) return targetValue;
  const origin = getSnapshotOrigin(incomingValue, graph.owner);
  if (origin !== undefined && isMergeableStateRecord(origin)) return origin;
  const preferredTarget = graph.preferredTargetByIncoming.get(incomingValue);
  if (preferredTarget !== undefined && isMergeableStateRecord(preferredTarget)) return preferredTarget;
  return Object.create(Reflect.getPrototypeOf(incomingValue) === null ? null : Object.prototype);
};

const restoreKeys = (value: object) => {
  const array = Array.isArray(value);
  return Reflect.ownKeys(value).filter((key) => !(array && key === "length"));
};

const registerRestoreTargets = (target: object, incoming: object, graph: RestoreGraph) => {
  for (const key of restoreKeys(incoming)) {
    const incomingValue = Reflect.get(incoming, key);
    if (typeof incomingValue !== "object" || incomingValue === null) continue;
    const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, key);
    const targetValue = targetPropertyValue(target, key, targetDescriptor);
    if (
      (Array.isArray(incomingValue) && Array.isArray(targetValue)) ||
      (isRestorableStateRecord(incomingValue) && isMergeableStateRecord(targetValue))
    ) {
      graph.preferredTargetByIncoming.set(incomingValue, targetValue);
    }
  }
};

type ValidateReplaceProperties = (target: object, incoming: object, graph: RestoreGraph) => void;
type ValidateRestoreNestedValue = (targetValue: unknown, incomingValue: unknown) => unknown;

const validateDecodedCollection = (
  incomingValue: object,
  incomingType: string | null,
  graph: RestoreGraph,
  validateValue: ValidateRestoreNestedValue,
): unknown => {
  if (!isDecodedTransportNode(incomingValue)) return undefined;
  if (incomingType === "Map") {
    const result = new Map<unknown, unknown>();
    graph.restoredByIncoming.set(incomingValue, result);
    for (const [key, value] of Map.prototype.entries.call(incomingValue)) {
      validateValue(undefined, key);
      validateValue(undefined, value);
    }
    return result;
  }
  if (incomingType === "Set") {
    const result = new Set<unknown>();
    graph.restoredByIncoming.set(incomingValue, result);
    for (const value of Set.prototype.values.call(incomingValue)) {
      validateValue(undefined, value);
    }
    return result;
  }
  return undefined;
};

const validateRestoreValue = (
  targetValue: unknown,
  incomingValue: unknown,
  graph: RestoreGraph,
  validateProperties: ValidateReplaceProperties,
): unknown => {
  if (typeof incomingValue !== "object" || incomingValue === null) return incomingValue;
  const existing = graph.restoredByIncoming.get(incomingValue);
  if (existing !== undefined) return existing;
  const validateValue = (currentValue: unknown, value: unknown) =>
    validateRestoreValue(currentValue, value, graph, validateProperties);

  const brand = collectionBrandOf(targetValue);
  if (brand !== undefined && typeof targetValue === "object" && targetValue !== null) {
    graph.restoredByIncoming.set(incomingValue, targetValue);
    const data = readCollectionData(brand, incomingValue);
    if (data.brand === "map" && isProxyMapValue(targetValue)) {
      for (const [key, value] of data.entries) {
        const restoredKey = isDecodedTransportNode(incomingValue) ? validateValue(undefined, key) : key;
        validateValue(targetValue.get(restoredKey), value);
      }
    } else if (data.brand === "set" && isProxySetValue(targetValue)) {
      for (const value of data.values) validateValue(undefined, value);
    }
    return targetValue;
  }

  const incomingType = opaqueObjectType(incomingValue);
  const incomingBrand = collectionBrandOf(incomingValue);
  if (incomingBrand !== undefined) {
    const result = createReactiveCollection(incomingBrand);
    graph.restoredByIncoming.set(incomingValue, result);
    const data = readCollectionData(incomingBrand, incomingValue);
    if (data.brand === "map") {
      for (const [key, value] of data.entries) {
        validateValue(undefined, key);
        validateValue(undefined, value);
      }
    } else {
      for (const value of data.values) validateValue(undefined, value);
    }
    return result;
  }

  const decodedCollection = validateDecodedCollection(incomingValue, incomingType, graph, validateValue);
  if (decodedCollection !== undefined) return decodedCollection;

  if (
    hasInternalSlots(incomingValue) ||
    (Object.isFrozen(incomingValue) && !isMaterializedSnapshotNode(incomingValue))
  ) {
    graph.restoredByIncoming.set(incomingValue, incomingValue);
    return incomingValue;
  }

  if (Array.isArray(incomingValue)) {
    const target = restoreArrayTarget(targetValue, incomingValue, graph);
    graph.restoredByIncoming.set(incomingValue, target);
    registerRestoreTargets(target, incomingValue, graph);
    validateProperties(target, incomingValue, graph);
    if (target.length !== incomingValue.length) assertCanAssignStateProperty(target, "length");
    return target;
  }

  if (isRestorableStateRecord(incomingValue)) {
    const target = restoreRecordTarget(targetValue, incomingValue, graph);
    graph.restoredByIncoming.set(incomingValue, target);
    registerRestoreTargets(target, incomingValue, graph);
    validateProperties(target, incomingValue, graph);
    return target;
  }

  graph.restoredByIncoming.set(incomingValue, incomingValue);
  return incomingValue;
};

const validateReplaceProperties = (target: object, incoming: object, graph: RestoreGraph): void => {
  for (const key of restoreKeys(incoming)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (isGetterOnly(descriptor)) continue;
    const incomingDescriptor = Reflect.getOwnPropertyDescriptor(incoming, key);
    if (incomingDescriptor === undefined) continue;
    const incomingValue = Reflect.get(incoming, key);
    const targetValue = targetPropertyValue(target, key, descriptor);
    if (typeof incomingValue === "function" || typeof targetValue === "function") continue;
    const restored = validateRestoreValue(targetValue, incomingValue, graph, validateReplaceProperties);
    if (descriptor === undefined || !sameAppliedValue(targetValue, restored)) {
      assertCanAssignStateProperty(target, key);
    }
    assertCanRestoreEnumerability(key, descriptor, incomingDescriptor);
  }

  for (const key of restoreKeys(target)) {
    if (Object.hasOwn(incoming, key)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined || isGetterOnly(descriptor)) continue;
    if (Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function") continue;
    assertCanDeleteStateProperty(key, descriptor);
  }
};

const writeRestoredProperty = (
  target: object,
  key: string | symbol,
  value: unknown,
  incomingDescriptor: PropertyDescriptor,
) => {
  const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (targetDescriptor === undefined && incomingDescriptor.enumerable === false) {
    if (
      !Reflect.defineProperty(target, key, {
        value,
        enumerable: false,
        configurable: true,
        writable: true,
      })
    ) {
      throw new TypeError(`statelift: cannot define state property "${String(key)}" during restore`);
    }
    return;
  }
  if (
    targetDescriptor === undefined ||
    !sameAppliedValue(targetPropertyValue(target, key, targetDescriptor), value)
  ) {
    writeStateProperty(target, key, value);
  }
  if (
    targetDescriptor !== undefined &&
    Object.hasOwn(targetDescriptor, "value") &&
    targetDescriptor.enumerable !== incomingDescriptor.enumerable &&
    !Reflect.defineProperty(target, key, { enumerable: incomingDescriptor.enumerable })
  ) {
    throw new TypeError(`statelift: cannot restore enumerability for state property "${String(key)}"`);
  }
};

const applyReplaceProperties = (
  target: object,
  incoming: object,
  restoreNestedValue: (targetValue: unknown, incomingValue: unknown) => unknown,
) => {
  for (const key of restoreKeys(incoming)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (isGetterOnly(descriptor)) continue;
    const incomingDescriptor = Reflect.getOwnPropertyDescriptor(incoming, key);
    if (incomingDescriptor === undefined) continue;
    const incomingValue = Reflect.get(incoming, key);
    const targetValue = targetPropertyValue(target, key, descriptor);
    if (typeof incomingValue === "function" || typeof targetValue === "function") continue;
    const restored = restoreNestedValue(targetValue, incomingValue);
    if (shouldRestoreProperty(targetValue, restored, descriptor, incomingDescriptor)) {
      writeRestoredProperty(target, key, restored, incomingDescriptor);
    }
  }

  for (const key of restoreKeys(target)) {
    if (Object.hasOwn(incoming, key)) continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (
      isGetterOnly(descriptor) ||
      (descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function")
    ) {
      continue;
    }
    if (!Reflect.deleteProperty(target, key)) {
      const targetName = Array.isArray(target) ? "array" : "state";
      throw new TypeError(`statelift: cannot delete ${targetName} property "${String(key)}" during restore`);
    }
  }
};

const restoreValue = (targetValue: unknown, incomingValue: unknown, graph: RestoreGraph): unknown => {
  if (typeof incomingValue !== "object" || incomingValue === null) return incomingValue;
  const existing = graph.restoredByIncoming.get(incomingValue);
  if (existing !== undefined) return existing;
  const restoreNestedValue = (currentValue: unknown, value: unknown) =>
    restoreValue(currentValue, value, graph);

  if (collectionBrandOf(targetValue) !== undefined) {
    if (typeof targetValue !== "object" || targetValue === null) return incomingValue;
    graph.restoredByIncoming.set(incomingValue, targetValue);
    applyCollectionData(
      targetValue,
      incomingValue,
      (value, current) => restoreNestedValue(current, value),
      (key) => (isDecodedTransportNode(incomingValue) ? restoreNestedValue(undefined, key) : key),
    );
    return targetValue;
  }

  const incomingType = opaqueObjectType(incomingValue);
  const incomingBrand = collectionBrandOf(incomingValue);
  if (incomingBrand !== undefined) {
    const result = createReactiveCollection(incomingBrand);
    graph.restoredByIncoming.set(incomingValue, result);
    applyCollectionData(
      result,
      incomingValue,
      (value) => restoreNestedValue(undefined, value),
      (key) => (isDecodedTransportNode(incomingValue) ? restoreNestedValue(undefined, key) : key),
    );
    return result;
  }

  if (isDecodedTransportNode(incomingValue) && incomingType === "Map") {
    const result = new Map<unknown, unknown>();
    graph.restoredByIncoming.set(incomingValue, result);
    for (const [key, value] of Map.prototype.entries.call(incomingValue)) {
      result.set(restoreNestedValue(undefined, key), restoreNestedValue(undefined, value));
    }
    return result;
  }
  if (isDecodedTransportNode(incomingValue) && incomingType === "Set") {
    const result = new Set<unknown>();
    graph.restoredByIncoming.set(incomingValue, result);
    for (const value of Set.prototype.values.call(incomingValue)) {
      result.add(restoreNestedValue(undefined, value));
    }
    return result;
  }

  if (hasInternalSlots(incomingValue)) {
    graph.restoredByIncoming.set(incomingValue, incomingValue);
    return incomingValue;
  }

  if (Object.isFrozen(incomingValue) && !isMaterializedSnapshotNode(incomingValue)) {
    graph.restoredByIncoming.set(incomingValue, incomingValue);
    return incomingValue;
  }

  if (Array.isArray(incomingValue)) {
    const target = restoreArrayTarget(targetValue, incomingValue, graph);
    graph.restoredByIncoming.set(incomingValue, target);
    registerRestoreTargets(target, incomingValue, graph);
    applyReplaceProperties(target, incomingValue, restoreNestedValue);
    if (
      target.length !== incomingValue.length &&
      !Reflect.set(target, "length", incomingValue.length, target)
    ) {
      throw new TypeError(`statelift: cannot resize restored array to length ${incomingValue.length}`);
    }
    return target;
  }

  if (isRestorableStateRecord(incomingValue)) {
    const target = restoreRecordTarget(targetValue, incomingValue, graph);
    graph.restoredByIncoming.set(incomingValue, target);
    registerRestoreTargets(target, incomingValue, graph);
    applyReplaceProperties(target, incomingValue, restoreNestedValue);
    return target;
  }

  graph.restoredByIncoming.set(incomingValue, incomingValue);
  return incomingValue;
};

/** Restores snapshot or plain data with deep replace semantics while preserving actions and getters. */
export const restore = <T extends {}>(store: Store<T>, data: Snapshot<NoInfer<T>>): void => {
  const internals = requireStoreInternals(store);
  if (data === null || typeof data !== "object") return;
  const owner = snapshotOwnerMap.get(store.state);
  if (owner === undefined) {
    throw new Error("statelift: cannot restore this store because its snapshot metadata is missing");
  }
  validateRestoreValue(store.state, data, createRestoreGraph(owner), validateReplaceProperties);
  internals.startBatch();
  try {
    // Validation and application require independent graph state.
    restoreValue(store.state, data, createRestoreGraph(owner));
  } finally {
    internals.endBatch();
  }
};

type StoreStates<S> = { [K in keyof S]: S[K] extends Store<infer ST extends {}> ? ST : never };

/** Creates a read-only store derived from tracked reads of one or more stores. */
export function computed<T extends {}, R>(
  source: Store<T>,
  derive: (state: T) => R,
): Store<{ readonly value: R }>;
export function computed<S extends Record<string, Store<{}>>, R>(
  source: S,
  derive: (states: StoreStates<S>) => R,
): Store<{ readonly value: R }>;
export function computed<R>(
  source: Record<string, Store<{}>> | Store<{}>,
  derive: (arg: never) => R,
): Store<{ readonly value: R }> {
  const isSingle = "state" in source && stateToStoreInternalsMap.has((source as Store<{}>).state);
  const sources: [string, Store<{}>][] =
    isSingle ? [["source", source as Store<{}>]] : Object.entries(source as Record<string, Store<{}>>);

  let out: Store<{ value: R }> | null = null;
  let current: R;

  const consumers: [string, Consumer<{}>][] = [];

  const evaluate = () => {
    for (const [, consumer] of consumers) {
      consumer.refreshDependencies();
    }
    const fn = derive as (arg: unknown) => R;
    if (isSingle) {
      const sourceConsumer = consumers[0];
      if (sourceConsumer === undefined) {
        throw new Error("statelift: computed source consumer is missing");
      }
      return fn(sourceConsumer[1].proxy);
    }
    const states: Record<string, unknown> = {};
    for (const [key, consumer] of consumers) {
      states[key] = consumer.proxy;
    }
    return fn(states);
  };

  const onSourceChange = () => {
    let next: R;
    try {
      next = evaluate();
    } catch (error) {
      // Preserve the previous value and surface the error after source delivery.
      queueMicrotask(() => {
        throw error;
      });
      return;
    }
    if (!Object.is(next, current)) {
      current = next;
      // A derivation can write its source before the output store exists.
      if (out !== null) out.state.value = next;
    }
  };

  try {
    for (const [key, sourceStore] of sources) {
      consumers.push([key, createConsumer(sourceStore, onSourceChange)]);
    }
    current = evaluate();
    out = createStore({ value: current });
  } catch (error) {
    for (const [, consumer] of consumers) consumer.destroy();
    throw error;
  }
  return out as Store<{ readonly value: R }>;
}

export type DeepPartial<T> =
  T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? T
  : T extends {} ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

/** Deep-merges data into a store in one batch. */
export type HydrateOptions = {
  /** Validates decoded untrusted input before the store is mutated. */
  validate: (data: unknown) => boolean;
};

export function hydrate<T extends {}>(
  store: Store<T>,
  data: DeepPartial<NoInfer<T>> | Dehydrated<NoInfer<T>>,
): void;
export function hydrate<T extends {}>(store: Store<T>, data: unknown, options: HydrateOptions): void;
export function hydrate<T extends {}>(store: Store<T>, data: unknown, options?: HydrateOptions): void {
  const internals = requireStoreInternals(store);
  const decoded = isDehydrated(data) ? decodeTransport(data) : data;
  if (options !== undefined && !options.validate(decoded)) {
    throw new TypeError("statelift: hydration data failed validation");
  }
  internals.hydrate(decoded);
}

export type { Dehydrated } from "./transport";

/** Encodes a store snapshot as a JSON-safe transport graph. */
export const dehydrate = <T extends {}>(store: Store<T>): Dehydrated<T> =>
  encodeTransport<T>(snapshot(store));

type PathImpl<T, Depth extends number[]> =
  Depth["length"] extends 4 ? never
  : {
      [K in keyof T & string]: K extends `${string}.${string}` ? never
      : NonNullable<T[K]> extends (...args: never[]) => unknown ? never
      : NonNullable<T[K]> extends readonly unknown[] ? K
      : NonNullable<T[K]> extends object ? K | `${K}.${PathImpl<NonNullable<T[K]>, [...Depth, 0]>}`
      : K;
    }[keyof T & string];
/** Dotted paths up to four levels deep. */
export type Path<T> = PathImpl<T, []>;
export type PathValue<T, P extends string> =
  P extends `${infer Head}.${infer Rest}` ?
    Head extends keyof T ?
      undefined extends T[Head] ? PathValue<NonNullable<T[Head]>, Rest> | undefined
      : null extends T[Head] ? PathValue<NonNullable<T[Head]>, Rest> | undefined
      : PathValue<T[Head], Rest>
    : undefined
  : P extends keyof T ? T[P]
  : undefined;

export type SubscribeOptions = {
  /** Invoke the callback once, synchronously, at subscribe time. */
  fireImmediately?: boolean;
};
export type SelectorSubscribeOptions<R> = {
  /** Invoke the callback once at subscribe time with `(current, current)`. */
  fireImmediately?: boolean;
  /** Comparison for selected values; the callback fires only on inequality. Default: `Object.is`. */
  equalityFn?: (a: R, b: R) => boolean;
};

const trackSelectorValue = <T extends {}, R>(createdConsumer: CreatedConsumer<T>, selector: Selector<T, R>) =>
  createdConsumer.consumer.wrap(trackConsumerValue(createdConsumer.tracking, selector));

/** Subscribes to all changes, a selector, or a dotted path outside React. */
export function subscribe<T extends {}>(
  store: Store<T>,
  callback: () => void,
  options?: SubscribeOptions,
): () => void;
export function subscribe<T extends {}, R>(
  store: Store<T>,
  selector: Selector<T, R>,
  callback: (value: R, prevValue: R) => void,
  options?: SelectorSubscribeOptions<R>,
): () => void;
export function subscribe<T extends {}, P extends Path<T> & string>(
  store: Store<T>,
  path: P,
  callback: (value: PathValue<T, P>, prevValue: PathValue<T, P>) => void,
  options?: SelectorSubscribeOptions<PathValue<T, P>>,
): () => void;
export function subscribe<T extends {}, R>(
  store: Store<T>,
  selectorOrCallback: Selector<T, R> | (() => void) | string,
  callbackOrOptions?: SubscribeOptions | ((value: R, prevValue: R) => void),
  maybeOptions?: SelectorSubscribeOptions<R>,
): () => void {
  const internals = requireStoreInternals(store);

  if (typeof selectorOrCallback === "string") {
    const segments = selectorOrCallback.split(".");
    const pathSelector = (state: T) => {
      let node: unknown = state;
      for (const segment of segments) {
        if (node === null || typeof node !== "object") return undefined as R;
        node = (node as Record<string, unknown>)[segment];
      }
      return node as R;
    };
    return subscribe(
      store,
      pathSelector,
      callbackOrOptions as (value: R, prevValue: R) => void,
      maybeOptions,
    );
  }

  let unsubscribed = false;

  if (isFunction(callbackOrOptions)) {
    const selector = selectorOrCallback as Selector<T, R>;
    const callback = callbackOrOptions as (value: R, prevValue: R) => void;
    const options = maybeOptions;
    const equalityFn = options?.equalityFn ?? Object.is;

    let previous: R;
    const createdConsumer = createConsumerWithTracking(store, () => {
      let next: R;
      try {
        next = trackSelectorValue(createdConsumer, selector);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
        return;
      }
      if (equalityFn(next, previous)) return;
      const prev = previous;
      previous = next;
      try {
        Reflect.apply(callback, undefined, [next, prev]);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    });
    const consumer = createdConsumer.consumer;

    try {
      previous = trackSelectorValue(createdConsumer, selector);
      if (options?.fireImmediately) {
        Reflect.apply(callback, undefined, [previous, previous]);
      }
    } catch (error) {
      consumer.destroy();
      throw error;
    }

    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      consumer.destroy();
    };
  }

  const callback = selectorOrCallback as () => void;
  const options = callbackOrOptions as SubscribeOptions | undefined;
  const unregister = internals.registerListener({ callback });
  try {
    if (options?.fireImmediately) {
      Reflect.apply(callback, undefined, []);
    }
  } catch (error) {
    unregister();
    throw error;
  }

  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    unregister();
  };
}
