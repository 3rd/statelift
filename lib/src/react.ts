import type { ReactElement, ReactNode, RefObject } from "react";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import type { DeepPartial, Dehydrated, Selector, Store, UseStoreOptions } from "./store";
import { activatePersistence, disposePersistence, persistenceActivation } from "./persist";
import { COLLECTION_BRAND, getSnapshotRawOrigin, TRACK_WITH_PRESERVED_DEPENDENCIES } from "./proxy";
import { createConsumer, hydrate, snapshot as takeSnapshot } from "./store";

const UNINITIALIZED = Symbol("UNINITIALIZED");
const noop = () => {};

const serverSnapshotCache = new WeakMap<object, object>();

const snapshotHasActions = (value: unknown, visited = new WeakSet<object>()): boolean => {
  if (value === null || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  const collectionBrand = Reflect.getOwnPropertyDescriptor(value, COLLECTION_BRAND)?.value;
  if (collectionBrand === "map" && value instanceof Map) {
    for (const [key, entryValue] of value) {
      if (snapshotHasActions(key, visited) || snapshotHasActions(entryValue, visited)) return true;
    }
    return false;
  }
  if (collectionBrand === "set" && value instanceof Set) {
    for (const entryValue of value) {
      if (snapshotHasActions(entryValue, visited)) return true;
    }
    return false;
  }

  const raw = getSnapshotRawOrigin(value);
  if (raw === undefined) return false;
  for (const key of Reflect.ownKeys(raw)) {
    if (Array.isArray(raw) && key === "length") continue;
    const snapshotDescriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (snapshotDescriptor !== undefined) {
      if (snapshotHasActions(snapshotDescriptor.value, visited)) return true;
      continue;
    }
    const rawDescriptor = Reflect.getOwnPropertyDescriptor(raw, key);
    if (
      rawDescriptor !== undefined &&
      Object.hasOwn(rawDescriptor, "value") &&
      typeof rawDescriptor.value === "function"
    ) {
      return true;
    }
  }
  return false;
};

const copyServerSnapshotCollectionProperties = (source: object, target: object) => {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (descriptor !== undefined) Object.defineProperty(target, key, descriptor);
  }
  if (Object.isFrozen(source)) Object.freeze(target);
};

const preserveServerSnapshotActions = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  const cached = serverSnapshotCache.get(value);
  if (cached !== undefined) return cached;
  if (!snapshotHasActions(value)) {
    serverSnapshotCache.set(value, value);
    return value;
  }

  const collectionBrand = Reflect.getOwnPropertyDescriptor(value, COLLECTION_BRAND)?.value;
  if (collectionBrand === "map" && value instanceof Map) {
    const result = new Map<unknown, unknown>();
    serverSnapshotCache.set(value, result);
    for (const [key, entryValue] of value) {
      result.set(preserveServerSnapshotActions(key), preserveServerSnapshotActions(entryValue));
    }
    copyServerSnapshotCollectionProperties(value, result);
    return result;
  }
  if (collectionBrand === "set" && value instanceof Set) {
    const result = new Set<unknown>();
    serverSnapshotCache.set(value, result);
    for (const entryValue of value) {
      result.add(preserveServerSnapshotActions(entryValue));
    }
    copyServerSnapshotCollectionProperties(value, result);
    return result;
  }

  const raw = getSnapshotRawOrigin(value);
  if (raw === undefined) return value;

  const result = Array.isArray(value) ? [] : {};
  if (Array.isArray(result) && Array.isArray(value)) result.length = value.length;
  serverSnapshotCache.set(value, result);

  for (const key of Reflect.ownKeys(raw)) {
    if (Array.isArray(raw) && key === "length") continue;
    const snapshotDescriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (snapshotDescriptor !== undefined) {
      Object.defineProperty(result, key, {
        value: preserveServerSnapshotActions(snapshotDescriptor.value),
        enumerable: snapshotDescriptor.enumerable,
        configurable: true,
        writable: true,
      });
      continue;
    }

    const rawDescriptor = Reflect.getOwnPropertyDescriptor(raw, key);
    if (rawDescriptor === undefined || !Object.hasOwn(rawDescriptor, "value")) continue;
    const action: unknown = rawDescriptor.value;
    if (typeof action !== "function") continue;
    Object.defineProperty(result, key, {
      value: action,
      enumerable: rawDescriptor.enumerable ?? false,
      configurable: true,
      writable: true,
    });
  }

  if (Object.isFrozen(value)) Object.freeze(result);
  return result;
};

let pendingTeardown: (() => void)[] = [];
let teardownScheduled = false;
const scheduleTeardown = (check: () => void) => {
  pendingTeardown.push(check);
  if (teardownScheduled) return;
  teardownScheduled = true;
  queueMicrotask(() => {
    teardownScheduled = false;
    const checks = pendingTeardown;
    pendingTeardown = [];
    for (const pendingCheck of checks) {
      pendingCheck();
    }
  });
};

type Consumer<T extends {}> = {
  proxy: T;
  activate: () => void;
  destroy: () => void;
  refreshDependencies: () => void;
  track: <R>(fn: (state: T) => R) => R;
  [TRACK_WITH_PRESERVED_DEPENDENCIES]: <R>(fn: (state: T) => R) => R;
  wrap: <V>(value: V) => V;
};

const isReactConsumer = <T extends {}>(
  consumer: ReturnType<typeof createConsumer<T>>,
): consumer is Consumer<T> => TRACK_WITH_PRESERVED_DEPENDENCIES in consumer;

const createReactConsumer = <T extends {}>(store: Store<T>, onStoreChange: () => void) => {
  const consumer = createConsumer(store, onStoreChange, { deferRegistration: true });
  if (!isReactConsumer(consumer)) {
    throw new Error(
      'statelift: incompatible React consumer; make sure "statelift" and "statelift/react" resolve to the same installed version',
    );
  }
  return consumer;
};

type ConsumerInput<T extends {}, R> = {
  selector: Selector<T, R> | undefined;
  equalityFn: (left: R, right: R) => boolean;
};
type BoundUseStore<T extends {}> = {
  (): T;
  <R>(selector: Selector<T, R>, options?: UseStoreOptions<R>): R;
};

const createMemoizedConsumer = <T extends {}, R>(
  store: Store<T>,
  inputRef: RefObject<ConsumerInput<T, R>>,
) => {
  let referenceCount = 0;
  let callbackRef = noop;
  let snapshot: R | typeof UNINITIALIZED = UNINITIALIZED;
  let lastSelector: Selector<T, R> | undefined;
  let destroyed = false;
  let teardownPending = false;
  let needsDependencyRefresh = false;
  let consumer: Consumer<T>;

  const onStoreChange = () => {
    const input = inputRef.current;
    const selector = input.selector;
    lastSelector = selector;
    if (selector) {
      const trackedValue = consumer.track(selector);
      const newValue = consumer.wrap(trackedValue);
      if (snapshot !== UNINITIALIZED && input.equalityFn(newValue, snapshot as R)) return;
      snapshot = newValue;
    } else {
      consumer.wrap(undefined);
      // Refresh during getSnapshot so reads outside render keep their dependencies until rendering starts.
      needsDependencyRefresh = true;
      snapshot = new Proxy(consumer.proxy, {}) as unknown as R;
    }
    callbackRef();
  };

  consumer = createReactConsumer(store, onStoreChange);

  // A preserved hook can resubscribe after its refcounted consumer was destroyed.
  const ensureConsumer = () => {
    if (!destroyed) return;
    destroyed = false;
    consumer = createReactConsumer(store, onStoreChange);
    snapshot = UNINITIALIZED;
    needsDependencyRefresh = false;
  };

  const checkDestroy = () => {
    teardownPending = false;
    if (referenceCount === 0 && !destroyed) {
      destroyed = true;
      consumer.destroy();
      snapshot = UNINITIALIZED;
      lastSelector = undefined;
      needsDependencyRefresh = false;
    }
  };

  const subscribe = (callback: () => void) => {
    ensureConsumer();
    callbackRef = callback;
    referenceCount++;
    try {
      consumer.activate();
    } catch (error) {
      referenceCount--;
      throw error;
    }
    return () => {
      referenceCount--;
      if (!teardownPending) {
        teardownPending = true;
        scheduleTeardown(checkDestroy);
      }
    };
  };

  const getSnapshot = () => {
    ensureConsumer();
    if (needsDependencyRefresh) {
      needsDependencyRefresh = false;
      consumer.refreshDependencies();
    }
    const input = inputRef.current;
    const selector = input.selector;
    if (snapshot === UNINITIALIZED || selector !== lastSelector) {
      if (selector) {
        const trackedValue =
          snapshot === UNINITIALIZED ?
            consumer.track(selector)
          : consumer[TRACK_WITH_PRESERVED_DEPENDENCIES](selector);
        const newValue = consumer.wrap(trackedValue);
        // Preserve equal snapshot references to satisfy useSyncExternalStore's identity contract.
        if (snapshot === UNINITIALIZED || !input.equalityFn(newValue, snapshot as R)) {
          snapshot = newValue;
        }
      } else {
        consumer.wrap(undefined);
        snapshot = consumer.proxy as unknown as R;
      }
      lastSelector = selector;
    }
    return snapshot as R;
  };

  // Cache server values by snapshot and selector identity.
  let serverBase: unknown = UNINITIALIZED;
  let serverSelector: Selector<T, R> | undefined;
  let serverValue: R | typeof UNINITIALIZED = UNINITIALIZED;

  const getServerSnapshot = () => {
    const snap = preserveServerSnapshotActions(takeSnapshot(store));
    const selector = inputRef.current.selector;
    if (serverBase !== snap || serverSelector !== selector || serverValue === UNINITIALIZED) {
      serverBase = snap;
      serverSelector = selector;
      serverValue = selector ? selector(snap as unknown as T) : (snap as unknown as R);
    }
    return serverValue as R;
  };

  return { subscribe, getSnapshot, getServerSnapshot };
};

export function useStore<T extends {}>(store: Store<T>): T;
export function useStore<T extends {}, R>(
  store: Store<T>,
  selector: Selector<T, R>,
  options?: UseStoreOptions<R>,
): R;
export function useStore<T extends {}, R>(
  store: Store<T>,
  selector?: Selector<T, R>,
  options?: UseStoreOptions<R>,
) {
  const inputRef = useRef<ConsumerInput<T, R>>({
    selector,
    equalityFn: options?.equalityFn ?? Object.is,
  });
  inputRef.current.selector = selector;
  inputRef.current.equalityFn = options?.equalityFn ?? Object.is;

  const memoizedConsumer = useMemo(() => createMemoizedConsumer<T, R>(store, inputRef), [store]);

  return useSyncExternalStore(
    memoizedConsumer.subscribe,
    memoizedConsumer.getSnapshot,
    memoizedConsumer.getServerSnapshot,
  );
}

/** Creates a useStore hook bound to one store. */
export const createUseStore = <T extends {}>(store: Store<T>): BoundUseStore<T> => {
  function useStoreHook(): T;
  function useStoreHook<R>(selector: Selector<T, R>, options?: UseStoreOptions<R>): R;
  function useStoreHook<R>(selector?: Selector<T, R>, options?: UseStoreOptions<R>) {
    return useStore(store, selector as Selector<T, R>, options);
  }
  return useStoreHook;
};

/** Creates a Provider and bound hooks from a store or per-Provider store factory. */
type ProviderChildren = { children?: ReactNode };
type FactoryProviderProps<T extends {}> =
  | (ProviderChildren & { store: Store<T>; data?: never })
  | (ProviderChildren & { store?: undefined; data?: DeepPartial<T> | Dehydrated<T> });
type SingletonProviderProps<T extends {}> = ProviderChildren & { store?: Store<T>; data?: never };
type ProviderProps<T extends {}> = {
  store?: Store<T>;
  data?: DeepPartial<T> | Dehydrated<T>;
  children?: ReactNode;
};
type StoreContextResult<T extends {}, Props> = {
  Provider: (props: Props) => ReactElement;
  useStore: { (): T; <R>(selector: Selector<T, R>, options?: UseStoreOptions<R>): R };
  useStoreInstance: () => Store<T>;
};

const surfaceAsyncError = (error: unknown) => {
  queueMicrotask(() => {
    throw error;
  });
};

export function createStoreContext<T extends {}>(
  source: () => Store<T>,
): StoreContextResult<T, FactoryProviderProps<T>>;
export function createStoreContext<T extends {}>(
  source: Store<T>,
): StoreContextResult<T, SingletonProviderProps<T>>;
export function createStoreContext<T extends {}>(
  source: Store<T> | (() => Store<T>),
): StoreContextResult<T, ProviderProps<T>> {
  const fallback = typeof source === "function" ? null : source;
  const StoreContext = createContext<Store<T> | null>(fallback);

  const usePersistenceLease = (value: Store<T>) => {
    useEffect(() => {
      if (persistenceActivation(value) !== "manual") return;
      return activatePersistence(value);
    }, [value]);
  };

  const LeadingActivationLease = ({ value }: { value: Store<T> }) => {
    usePersistenceLease(value);
    return null;
  };

  const ActivationLease = ({ value, children }: { value: Store<T>; children?: ReactNode }) => {
    usePersistenceLease(value);

    // Child-order effects activate persistence before descendants while retaining boundary cleanup.
    return createElement(
      StoreContext.Provider,
      { value },
      createElement(LeadingActivationLease, { value }),
      children,
    );
  };

  const rejectSuppliedStoreData = (): never => {
    throw new Error(
      "statelift: Provider cannot apply data to an existing store; call hydrate(store, data) before rendering",
    );
  };

  const FactoryStoreProvider = ({
    create,
    data,
    children,
  }: {
    create: () => Store<T>;
    data: DeepPartial<T> | Dehydrated<T> | undefined;
    children?: ReactNode;
  }) => {
    // Reducer state keeps one store for the mount and applies hydration before children render.
    const [value] = useReducer(
      (current: Store<T>) => current,
      create,
      (createStoreForMount) => {
        const resolved = createStoreForMount();
        const activation = persistenceActivation(resolved);
        if (activation === "immediate") {
          disposePersistence(resolved).catch(surfaceAsyncError);
          throw new Error(
            'statelift: Provider requires persist.activation: "manual" for factory-created persisted stores',
          );
        }
        if (activation !== null && data !== undefined) {
          throw new Error(
            "statelift: Provider data cannot be combined with persistence; create the store first, call rehydrate() and hydrate(), then pass it through the store prop",
          );
        }
        if (data !== undefined) hydrate(resolved, data);
        return resolved;
      },
    );

    return createElement(ActivationLease, { value }, children);
  };

  const Provider = ({ store, data, children }: ProviderProps<T>) => {
    const initialData = useRef(data);
    if (store !== undefined) {
      if (initialData.current !== undefined) rejectSuppliedStoreData();
      return createElement(ActivationLease, { value: store }, children);
    }
    if (typeof source === "function") {
      return createElement(FactoryStoreProvider, { create: source, data: initialData.current }, children);
    }
    if (initialData.current !== undefined) rejectSuppliedStoreData();
    return createElement(ActivationLease, { value: source }, children);
  };

  const useStoreInstance = () => {
    const store = useContext(StoreContext);
    if (!store) {
      throw new Error(
        "statelift: no store in context — wrap the tree in <Provider> or pass a store to createStoreContext",
      );
    }
    return store;
  };

  function useBoundStore(): T;
  function useBoundStore<R>(selector: Selector<T, R>, options?: UseStoreOptions<R>): R;
  function useBoundStore<R>(selector?: Selector<T, R>, options?: UseStoreOptions<R>) {
    return useStore(useStoreInstance(), selector as Selector<T, R>, options);
  }

  return { Provider, useStore: useBoundStore, useStoreInstance };
}
