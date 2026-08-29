import type { Snapshot, Store } from "./store";
import { COLLECTION_BRAND, definePlainDataProperty } from "./proxy";
import { IS_DEV } from "./utils";

export type StorageAdapter = {
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
};

export type PersistSerializer = {
  stringify: (value: unknown) => string;
  parse: (raw: string) => unknown;
};

export type PersistOptions<T extends {}> = {
  /** Storage key. */
  key: string;
  /** Storage backend, sync or async (e.g. AsyncStorage). Default: localStorage (guarded). */
  storage?: StorageAdapter;
  /** Schema version written with the payload. Default: 0. */
  version?: number;
  /** Migrates saved state from a different version; missing or throwing migration discards it. */
  migrate?: (saved: unknown, savedVersion: number) => Partial<T>;
  /** Persist only a subset of the state; receives the immutable public snapshot. */
  partialize?: (state: Snapshot<T>) => Partial<Snapshot<T>>;
  /** Payload codec replacing JSON. `migrate` receives the parsed value. */
  serializer?: PersistSerializer;
  /** Defers storage reads and writes until `rehydrate(store)`; call order with `hydrate` sets precedence. */
  skipHydration?: boolean;
  /** Runs once after hydration, synchronously for synchronous storage. */
  onHydrated?: () => void;
  /** Trailing-edge write throttle in milliseconds. Default: microtask debounce. */
  throttle?: number;
  /** Mirrors writes from other tabs when using the default localStorage adapter. */
  syncAcrossTabs?: boolean;
  /** Controls whether persistence starts immediately or waits for `activatePersistence(store)`. */
  activation?: "immediate" | "manual";
};

export type DisposePersistenceResult = {
  /** True when the final accepted state reached storage before disposal. */
  flushed: boolean;
};

export type PersistHandle = {
  activation: "immediate" | "manual";
  schedulePersist: () => void;
  activate: () => () => void;
  dispose: () => Promise<DisposePersistenceResult>;
};

type PersistenceActivation = PersistHandle["activation"] | null;

type InitPersistConfig<T extends {}> = {
  options: PersistOptions<T>;
  state: {};
  getSnapshot: () => Snapshot<T>;
  applyData: (data: unknown) => void;
};

type CollisionEntry = { state: WeakRef<{}>; token: object };
type CollisionCleanup = { adapter: WeakRef<StorageAdapter>; key: string; token: object };
const hasHydratedMap = new WeakMap<{}, boolean>();
const persistReadyMap = new WeakMap<{}, Promise<void>>();
const rehydrateMap = new WeakMap<{}, () => Promise<void>>();
const persistenceControllerMap = new WeakMap<{}, PersistHandle>();
const activeStoresByStorage: WeakMap<StorageAdapter, Map<string, CollisionEntry>> | null =
  IS_DEV ? new WeakMap<StorageAdapter, Map<string, CollisionEntry>>() : null;
const collisionFinalizer =
  IS_DEV && typeof FinalizationRegistry !== "undefined" ?
    new FinalizationRegistry<CollisionCleanup>(({ adapter, key, token }) => {
      const storage = adapter.deref();
      if (!storage) return;
      const byKey = activeStoresByStorage?.get(storage);
      if (byKey === undefined || !Object.is(byKey.get(key)?.token, token)) return;
      byKey.delete(key);
      if (byKey.size === 0) activeStoresByStorage?.delete(storage);
    })
  : null;

/** Reports whether the store's hydration attempt has finished. */
export const hasHydrated = <T extends {}>(store: Store<T>): boolean =>
  hasHydratedMap.get(store.state) ?? true;

/** Resolves when hydration finishes. */
export const persistReady = <T extends {}>(store: Store<T>): Promise<void> =>
  persistReadyMap.get(store.state) ?? Promise.resolve();

/** Reads storage and applies its value to the store. */
export const rehydrate = <T extends {}>(store: Store<T>): Promise<void> => {
  const run = rehydrateMap.get(store.state);
  return run ? run() : Promise.resolve();
};

/** Activates manually prepared persistence and returns an idempotent release function. */
export const activatePersistence = <T extends {}>(store: Store<T>): (() => void) => {
  const controller = persistenceControllerMap.get(store.state);
  return controller?.activate() ?? (() => {});
};

/** Releases persistence resources and reports whether the final accepted state reached storage. */
export const disposePersistence = <T extends {}>(store: Store<T>): Promise<DisposePersistenceResult> => {
  const controller = persistenceControllerMap.get(store.state);
  return controller?.dispose() ?? Promise.resolve({ flushed: true });
};

export const persistenceActivation = <T extends {}>(store: Store<T>): PersistenceActivation =>
  persistenceControllerMap.get(store.state)?.activation ?? null;

export const normalizePersistOptions = <T extends {}>(
  persist: PersistOptions<T> | string,
): PersistOptions<T> => (typeof persist === "string" ? { key: persist } : persist);

const defaultStorageAdapter: StorageAdapter = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => {
    localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    localStorage.removeItem(key);
  },
};

export const PERSIST_FORMAT = "statelift/persist";
const DEFAULT_SCHEMA_VERSION = 0;
type Envelope = readonly [typeof PERSIST_FORMAT, number, unknown];

const NUMBER_TAG_KEY = "$statelift.number";
const ESCAPE_TAG_KEY = "$statelift.escape";

const numberTagToken = (value: number) => {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "positive-infinity";
  if (value === -Infinity) return "negative-infinity";
  if (Object.is(value, -0)) return "negative-zero";
  return null;
};

const numberFromTagToken = (token: unknown) => {
  switch (token) {
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
      throw new TypeError(`statelift: unknown persisted number tag "${String(token)}"`);
    }
  }
};

const isReservedRecord = (value: object) => {
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === NUMBER_TAG_KEY || keys[0] === ESCAPE_TAG_KEY);
};

const isPersistedRootRecord = (value: unknown) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const warnCorruptPersistedState = (key: string) => {
  console.warn(`statelift: ignoring corrupt persisted state for key "${key}"`);
};

const decodePersistedScalars = (value: unknown, visited: Map<object, unknown> = new Map()): unknown => {
  if (value === null || typeof value !== "object") return value;
  const existing = visited.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    result.length = value.length;
    visited.set(value, result);
    for (let index = 0; index < value.length; index++) {
      if (Object.hasOwn(value, index)) result[index] = decodePersistedScalars(value[index], visited);
    }
    return result;
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === NUMBER_TAG_KEY) {
    return numberFromTagToken(Reflect.get(value, NUMBER_TAG_KEY));
  }
  if (keys.length === 1 && keys[0] === ESCAPE_TAG_KEY) {
    const inner = Reflect.get(value, ESCAPE_TAG_KEY);
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      throw new TypeError("statelift: malformed persisted escape wrapper");
    }
    const innerPrototype = Reflect.getPrototypeOf(inner);
    if ((innerPrototype !== Object.prototype && innerPrototype !== null) || !isReservedRecord(inner)) {
      throw new TypeError("statelift: malformed persisted escape wrapper");
    }
    const result: Record<string, unknown> = {};
    visited.set(value, result);
    for (const key of Object.keys(inner)) {
      definePlainDataProperty(result, key, decodePersistedScalars(Reflect.get(inner, key), visited));
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  visited.set(value, result);
  for (const key of keys) {
    definePlainDataProperty(result, key, decodePersistedScalars(Reflect.get(value, key), visited));
  }
  return result;
};

const isThenable = (value: unknown): value is Promise<unknown> => {
  if (value === null || typeof value !== "object") return false;
  return typeof Reflect.get(value, "then") === "function";
};

const encodePersistedCollections = (
  value: unknown,
  visited: WeakMap<object, unknown> = new WeakMap(),
): unknown => {
  if (typeof value === "number") {
    const token = numberTagToken(value);
    return token === null ? value : { [NUMBER_TAG_KEY]: token };
  }
  if (value === null || typeof value !== "object") return value;
  const existing = visited.get(value);
  if (existing !== undefined) return existing;

  const brandDescriptor = Reflect.getOwnPropertyDescriptor(value, COLLECTION_BRAND);
  if (brandDescriptor?.value === "map" && value instanceof Map) {
    const slots: Record<string, unknown> = {};
    const result = { slots, size: value.size };
    visited.set(value, result);
    let index = 0;
    for (const [key, entryValue] of value) {
      definePlainDataProperty(slots, `s${index++}`, {
        key: encodePersistedCollections(key, visited),
        value: encodePersistedCollections(entryValue, visited),
      });
    }
    return result;
  }
  if (brandDescriptor?.value === "set" && value instanceof Set) {
    const slots: Record<string, unknown> = {};
    const result = { slots, size: value.size };
    visited.set(value, result);
    let index = 0;
    for (const entryValue of value) {
      definePlainDataProperty(slots, `s${index++}`, {
        key: encodePersistedCollections(entryValue, visited),
      });
    }
    return result;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    result.length = value.length;
    visited.set(value, result);
    for (let index = 0; index < value.length; index++) {
      if (Object.hasOwn(value, index)) result[index] = encodePersistedCollections(value[index], visited);
    }
    return result;
  }

  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (isReservedRecord(value)) {
    const inner: Record<string, unknown> = {};
    const result = { [ESCAPE_TAG_KEY]: inner };
    visited.set(value, result);
    for (const key of Object.keys(value)) {
      definePlainDataProperty(inner, key, encodePersistedCollections(Reflect.get(value, key), visited));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  visited.set(value, result);
  for (const key of Object.keys(value)) {
    definePlainDataProperty(result, key, encodePersistedCollections(Reflect.get(value, key), visited));
  }
  return result;
};

const decodePayload = (raw: string, key: string, parse: PersistSerializer["parse"]): Envelope | null => {
  const warnCorrupt = () => {
    warnCorruptPersistedState(key);
    return null;
  };
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return warnCorrupt();
  }
  if (!Array.isArray(parsed)) {
    if (isPersistedRootRecord(parsed)) return [PERSIST_FORMAT, DEFAULT_SCHEMA_VERSION, parsed];
    return warnCorrupt();
  }

  if (parsed.length !== 3 || parsed[0] !== PERSIST_FORMAT || typeof parsed[1] !== "number") {
    return warnCorrupt();
  }
  try {
    return [PERSIST_FORMAT, parsed[1], decodePersistedScalars(parsed[2])];
  } catch {
    return warnCorrupt();
  }
};

export const initPersist = <T extends {}>(config: InitPersistConfig<T>): PersistHandle => {
  const { options, state } = config;
  const {
    activation = "immediate",
    key,
    migrate,
    onHydrated,
    partialize,
    serializer,
    skipHydration,
    storage: configuredStorage,
    syncAcrossTabs,
    throttle,
    version = DEFAULT_SCHEMA_VERSION,
  } = options;
  const usingDefaultStorage = configuredStorage === undefined;
  const storage = configuredStorage ?? defaultStorageAdapter;
  const stringify = serializer?.stringify ?? JSON.stringify;
  const parse = serializer?.parse ?? JSON.parse;
  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";

  const readFailureMessage =
    usingDefaultStorage ?
      `statelift: failed to read localStorage key "${key}"`
    : `statelift: failed to read storage key "${key}"`;
  const writeFailureMessage =
    usingDefaultStorage ?
      `statelift: failed to persist store to localStorage key "${key}" (quota exceeded or storage unavailable)`
    : `statelift: failed to persist store for key "${key}"`;

  let activationLeases = 0;
  let terminal = false;
  let writesEnabled = false;
  let scheduledMicrotask = false;
  let scheduledGeneration = 0;
  let persistWriteWarned = false;
  let persistSerializeWarned = false;
  let lastWriteFailed = false;
  let unflushedWarned = false;
  let midSessionReadActive = false;
  let hydratedNotified = false;
  let readySettled = false;
  let listenersInstalled = false;
  let storageAvailable = true;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let writeInFlight = false;
  let acceptedRevision = 0;
  let settledRevision = 0;
  let writeWaiters: { revision: number; resolve: () => void }[] = [];
  let hydrationGeneration = 0;
  let applyingHydrationData = false;
  let deferredWritePending = false;
  let localStorageArea: Storage | null = null;
  let collisionToken: object | null = null;
  let releaseBarrier: Promise<void> | null = null;
  let disposalPromise: Promise<DisposePersistenceResult> | null = null;

  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  persistReadyMap.set(state, readyPromise);
  hasHydratedMap.set(state, false);

  const settleReady = () => {
    if (readySettled) return;
    readySettled = true;
    readyResolve?.();
    readyResolve = null;
  };

  const registerCollision = () => {
    if (!IS_DEV || !activeStoresByStorage || collisionToken !== null) return;
    let byKey = activeStoresByStorage.get(storage);
    if (!byKey) {
      byKey = new Map();
      activeStoresByStorage.set(storage, byKey);
    }
    for (const [registeredKey, entry] of byKey) {
      if (entry.state.deref() === undefined) byKey.delete(registeredKey);
    }
    const previous = byKey.get(key)?.state.deref();
    if (previous !== undefined && !Object.is(previous, state)) {
      console.warn(
        `statelift: persist key "${key}" is already used by another live store on the same storage — last write wins`,
      );
    }
    const token = {};
    collisionToken = token;
    byKey.set(key, { state: new WeakRef(state), token });
    collisionFinalizer?.register(state, { adapter: new WeakRef(storage), key, token }, token);
  };

  const unregisterCollision = () => {
    const token = collisionToken;
    if (token === null || !activeStoresByStorage) return;
    collisionToken = null;
    collisionFinalizer?.unregister(token);
    const byKey = activeStoresByStorage.get(storage);
    if (byKey !== undefined && Object.is(byKey.get(key)?.token, token)) byKey.delete(key);
    if (byKey?.size === 0) activeStoresByStorage.delete(storage);
  };

  const warnWriteFailure = () => {
    if (persistWriteWarned) return;
    persistWriteWarned = true;
    console.warn(writeFailureMessage);
  };

  const warnSerializeFailure = (error: unknown) => {
    if (persistSerializeWarned) return;
    persistSerializeWarned = true;
    console.warn(`statelift: failed to serialize store for key "${key}" — nothing was persisted`, error);
  };

  const warnIfStoppedUnflushed = () => {
    if (!lastWriteFailed || unflushedWarned) return;
    unflushedWarned = true;
    console.warn(
      `statelift: persistence for key "${key}" stopped with unflushed writes (the last write failed)`,
    );
  };

  const resolveWriteWaiters = () => {
    const pending: typeof writeWaiters = [];
    for (const waiter of writeWaiters) {
      if (settledRevision >= waiter.revision) {
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }
    writeWaiters = pending;
  };

  const scheduleAcceptedWrite = (startAcceptedWrite: () => void) => {
    if (writeInFlight) return;
    if (throttle === undefined) {
      if (scheduledMicrotask) return;
      scheduledMicrotask = true;
      const generation = ++scheduledGeneration;
      queueMicrotask(() => {
        if (generation !== scheduledGeneration) return;
        scheduledMicrotask = false;
        startAcceptedWrite();
      });
      return;
    }
    if (throttleTimer !== null) return;
    const generation = ++scheduledGeneration;
    throttleTimer = setTimeout(() => {
      if (generation !== scheduledGeneration) return;
      throttleTimer = null;
      startAcceptedWrite();
    }, throttle);
  };

  const startWrite = () => {
    const finishWrite = (revision: number, failed: boolean) => {
      lastWriteFailed = failed;
      writeInFlight = false;
      settledRevision = Math.max(settledRevision, revision);
      resolveWriteWaiters();
      if (acceptedRevision > settledRevision) {
        if (writeWaiters.length > 0) startWrite();
        else if (writesEnabled) scheduleAcceptedWrite(startWrite);
      }
    };

    if (writeInFlight || acceptedRevision <= settledRevision || !storageAvailable) return;
    const revision = acceptedRevision;
    let serialized: string;
    try {
      const snap = config.getSnapshot();
      const selected = partialize ? partialize(snap) : snap;
      const payload = encodePersistedCollections(selected);
      const envelope: Envelope = [PERSIST_FORMAT, version, payload];
      serialized = stringify(envelope);
    } catch (error) {
      warnSerializeFailure(error);
      finishWrite(revision, true);
      return;
    }

    try {
      const result = storage.setItem(key, serialized);
      if (isThenable(result)) {
        writeInFlight = true;
        result.then(
          () => finishWrite(revision, false),
          () => {
            warnWriteFailure();
            finishWrite(revision, true);
          },
        );
      } else {
        finishWrite(revision, false);
      }
    } catch {
      warnWriteFailure();
      finishWrite(revision, true);
    }
  };

  const acceptWrite = () => {
    acceptedRevision++;
    scheduleAcceptedWrite(startWrite);
  };

  const acceptDeferredWrite = () => {
    acceptedRevision++;
    deferredWritePending = true;
  };

  const scheduleDeferredWrite = () => {
    if (!deferredWritePending || !writesEnabled) return;
    deferredWritePending = false;
    scheduleAcceptedWrite(startWrite);
  };

  const finishHydration = (enableWrites: boolean) => {
    midSessionReadActive = false;
    writesEnabled = enableWrites && activationLeases > 0 && !terminal;
    hasHydratedMap.set(state, true);
    settleReady();
    if (!hydratedNotified) {
      hydratedNotified = true;
      onHydrated?.();
    }
    scheduleDeferredWrite();
  };

  const cancelScheduledWrite = () => {
    scheduledGeneration++;
    scheduledMicrotask = false;
    if (throttleTimer !== null) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
  };

  const drainAcceptedWrites = () => {
    const targetRevision = acceptedRevision;
    cancelScheduledWrite();
    if (!storageAvailable || settledRevision >= targetRevision) return null;
    const promise = new Promise<void>((resolve) => {
      writeWaiters.push({ revision: targetRevision, resolve });
    });
    startWrite();
    return promise;
  };

  const applyDecoded = (envelope: Envelope | null) => {
    if (!envelope) return;

    const savedVersion = envelope[1];
    const savedState = envelope[2];
    let data: unknown;
    if (savedVersion === version) {
      data = savedState;
    } else if (migrate) {
      try {
        data = migrate(savedState, savedVersion);
      } catch {
        console.warn(
          `statelift: migration for key "${key}" threw (saved version ${savedVersion}); discarding persisted state`,
        );
        return;
      }
    } else {
      console.warn(
        `statelift: discarding persisted state for key "${key}" (saved version ${savedVersion}, expected ${version}, no migrate)`,
      );
      return;
    }

    if (!isPersistedRootRecord(data)) {
      warnCorruptPersistedState(key);
      return;
    }
    applyingHydrationData = true;
    try {
      config.applyData(data);
    } finally {
      applyingHydrationData = false;
    }
  };

  const completeHydration = (generation: number) => {
    if (generation !== hydrationGeneration || terminal) return;
    finishHydration(activationLeases > 0);
  };

  const hasConcurrentMidSessionWrite = () => midSessionReadActive && deferredWritePending;

  const startRead = (generation: number, allowInactive: boolean) => {
    if (
      generation !== hydrationGeneration ||
      terminal ||
      (!allowInactive && activationLeases === 0) ||
      !storageAvailable
    ) {
      return Promise.resolve();
    }
    let raw: Promise<string | null> | string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      if (generation === hydrationGeneration) {
        console.warn(readFailureMessage);
        completeHydration(generation);
      }
      return Promise.resolve();
    }

    if (isThenable(raw)) {
      return raw.then(
        (resolved) => {
          if (generation !== hydrationGeneration) return;
          // Writes accepted after this read starts take precedence over storage.
          if (typeof resolved === "string" && !hasConcurrentMidSessionWrite()) {
            try {
              applyDecoded(decodePayload(resolved, key, parse));
            } catch (error) {
              console.warn(
                `statelift: failed to apply persisted state for key "${key}"; continuing with the current state`,
                error,
              );
            }
          }
          completeHydration(generation);
        },
        () => {
          if (generation !== hydrationGeneration) return;
          console.warn(readFailureMessage);
          completeHydration(generation);
        },
      );
    }
    if (generation !== hydrationGeneration) return Promise.resolve();
    if (typeof raw === "string" && !hasConcurrentMidSessionWrite()) {
      try {
        applyDecoded(decodePayload(raw, key, parse));
      } catch (error) {
        completeHydration(generation);
        throw error;
      }
    }
    completeHydration(generation);
    return Promise.resolve();
  };

  const readAndApply = () => {
    const midSessionReadAlreadyActive = midSessionReadActive;
    const generation = ++hydrationGeneration;
    const allowInactive = activationLeases === 0 && activation === "manual";
    const midSession = hasHydratedMap.get(state) === true;
    writesEnabled = false;
    if (!midSession) deferredWritePending = false;
    midSessionReadActive = midSession;
    const barrier = midSessionReadAlreadyActive && deferredWritePending ? null : drainAcceptedWrites();
    return barrier ?
        barrier.then(() => startRead(generation, allowInactive))
      : startRead(generation, allowInactive);
  };

  rehydrateMap.set(state, readAndApply);

  const schedulePersist = () => {
    if (terminal) return;
    if (!writesEnabled) {
      if (
        activationLeases > 0 &&
        (applyingHydrationData || midSessionReadActive || releaseBarrier !== null)
      ) {
        acceptDeferredWrite();
      }
      return;
    }
    acceptWrite();
  };

  const onPageHide = () => {
    if (throttleTimer !== null) drainAcceptedWrites();
  };

  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== localStorageArea || event.key !== key || event.newValue === null) return;
    if (!writesEnabled) return;
    try {
      applyDecoded(decodePayload(event.newValue, key, parse));
    } catch (error) {
      console.warn(`statelift: failed to apply synced state for key "${key}"`, error);
    }
  };

  const installExternalResources = () => {
    if (listenersInstalled || !storageAvailable) return storageAvailable;
    if (usingDefaultStorage) {
      try {
        localStorageArea = globalThis.localStorage;
        localStorageArea.getItem(key);
      } catch {
        storageAvailable = false;
        console.warn(
          `statelift: persist "${key}" disabled — localStorage is unavailable in this environment`,
        );
        finishHydration(false);
        return false;
      }
    }
    registerCollision();
    if (hasWindow && throttle !== undefined && usingDefaultStorage) {
      window.addEventListener("pagehide", onPageHide);
    }
    if (hasWindow && syncAcrossTabs && usingDefaultStorage) {
      window.addEventListener("storage", onStorage);
    }
    listenersInstalled = true;
    return true;
  };

  const removeExternalResources = () => {
    if (listenersInstalled && hasWindow) {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("storage", onStorage);
    }
    listenersInstalled = false;
    unregisterCollision();
  };

  const surfaceAsyncError = (error: unknown) => {
    queueMicrotask(() => {
      throw error;
    });
  };

  const beginActivation = () => {
    if (terminal || activationLeases === 0 || !installExternalResources()) return;
    if (hasHydratedMap.get(state) === true) {
      writesEnabled = true;
      scheduleDeferredWrite();
      return;
    }
    if (!skipHydration) readAndApply().catch(surfaceAsyncError);
  };

  const finishRelease = () => {
    releaseBarrier = null;
    if (activationLeases > 0 && !terminal) beginActivation();
    else warnIfStoppedUnflushed();
  };

  const releaseLastLease = () => {
    writesEnabled = false;
    hydrationGeneration++;
    deferredWritePending = false;
    midSessionReadActive = false;
    removeExternalResources();
    const barrier = drainAcceptedWrites();
    if (barrier) {
      releaseBarrier = barrier;
      barrier.then(finishRelease, finishRelease);
    } else {
      warnIfStoppedUnflushed();
    }
  };

  const activate = () => {
    if (terminal) throw new Error("statelift: cannot activate disposed persistence");
    activationLeases++;
    if (activationLeases === 1 && releaseBarrier === null) {
      try {
        beginActivation();
      } catch (error) {
        activationLeases--;
        if (activationLeases === 0) releaseLastLease();
        throw error;
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (terminal) return;
      activationLeases--;
      if (activationLeases === 0) releaseLastLease();
    };
  };

  const dispose = (): Promise<DisposePersistenceResult> => {
    if (disposalPromise !== null) return disposalPromise;
    terminal = true;
    activationLeases = 0;
    writesEnabled = false;
    hydrationGeneration++;
    deferredWritePending = false;
    midSessionReadActive = false;
    removeExternalResources();
    const barrier = drainAcceptedWrites();
    disposalPromise = (barrier ?? Promise.resolve()).then(() => {
      warnIfStoppedUnflushed();
      hasHydratedMap.set(state, true);
      settleReady();
      rehydrateMap.delete(state);
      return { flushed: !lastWriteFailed };
    });
    return disposalPromise;
  };

  const controller: PersistHandle = { activation, schedulePersist, activate, dispose };
  persistenceControllerMap.set(state, controller);
  return controller;
};
