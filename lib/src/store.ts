/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useRef, useSyncExternalStore } from "react";
import { ProxyCacheValue, createDeepProxy } from "./proxy";

type StoreData<T> = T | ((root: T) => T);

type Store<T extends {}> = {
  state: StoreData<T>;
  subscribe: <K extends keyof StoreManager<any>["watchers"]>(event: K, watcher: (...args: any[]) => void) => () => void;
};

function createStoreData<T extends {}>(data: StoreData<T>): T {
  if (typeof data === "function") {
    const fnData: (root: T) => T = data as (root: T) => T;

    const handler: ProxyHandler<T> = {
      get(target, prop, receiver) {
        return Reflect.get(target, prop, receiver);
      },
    };

    const lazyRoot = new Proxy({}, handler) as T;
    const result = fnData(lazyRoot);

    handler.get = (_target, prop, receiver) => {
      return Reflect.get(result, prop, receiver);
    };
    return lazyRoot as T;
  }
  return data;
}

interface StoreOptions<T extends {}> {
  target: T;
}

class StoreManager<TState extends {}> {
  state: TState;
  watchers = {
    get: new Set<(proxy: ProxyCacheValue, target: {}, key: string | symbol, value: any) => void>(),
    set: new Set<(proxy: ProxyCacheValue, target: {}, key: string | symbol, value: any) => void>(),
    delete: new Set<(proxy: ProxyCacheValue, target: {}, key: string | symbol) => void>(),
  };

  constructor({ target }: StoreOptions<TState>) {
    this.state = createDeepProxy(target, {
      callbacks: {
        get: this.handleGet,
        set: this.handleSet,
        delete: this.handleDelete,
      },
    });
  }

  private handleGet = (proxy: ProxyCacheValue, target: any, key: string | symbol, value: any) => {
    // console.log("@manager get", target, key);
    for (const watcher of this.watchers.get) {
      watcher(proxy, target, key, value);
    }
  };

  private handleSet = (proxy: ProxyCacheValue, target: any, key: string | symbol, value: any) => {
    // console.log("@manager set", target, key, value);
    for (const watcher of this.watchers.set) {
      watcher(proxy, target, key, value);
    }
  };

  private handleDelete = (proxy: ProxyCacheValue, target: any, key: string | symbol) => {
    // console.log("@manager delete", target, key);
    for (const watcher of this.watchers.delete) {
      watcher(proxy, target, key);
    }
  };

  subscribe<T extends keyof typeof this.watchers>(event: T, watcher: (...args: any[]) => void) {
    this.watchers[event].add(watcher);
    return () => {
      this.watchers[event].delete(watcher);
    };
  }
}

export const createStore = <T extends {}>(target: T): Store<T> => {
  const manager = new StoreManager<T>({
    target: createStoreData(target),
  });

  return {
    state: manager.state,
    subscribe: manager.subscribe.bind(manager),
  } as Store<T>;
};

let useStoreHelperCount = 0;
export const useStore = <T extends {}>(store: Store<T>) => {
  const updateRef = useRef({});
  const observedPropertiesRef = useRef<WeakMap<any, Set<string | symbol>>>(new WeakMap());

  const singleton = useMemo(() => {
    const symbol = Symbol(`useStore:${++useStoreHelperCount}`);

    const handleGet = (_: ProxyCacheValue, target: any, key: string | symbol) => {
      if (observedPropertiesRef.current.has(target)) {
        observedPropertiesRef.current.get(target)!.add(key);
      } else {
        observedPropertiesRef.current.set(target, new Set([key]));
      }
    };

    const createHandleManagerUpdate =
      (callback: () => void) => (proxy: ProxyCacheValue, _target: any, key: string | symbol) => {
        const observedProperties = observedPropertiesRef.current.get(proxy.instance);
        if (!observedProperties || !observedProperties.has(key)) return;
        updateRef.current = {};
        callback();
      };

    const accessProxy = createDeepProxy(store.state, {
      rootSymbol: symbol,
      callbacks: {
        get: handleGet,
      },
    }) as unknown as T;

    const subscribe = (callback: () => void) => {
      console.log("subscribe");
      const subscriptions: (() => void)[] = [];
      const handleManagerUpdate = createHandleManagerUpdate(callback);
      subscriptions.push(store.subscribe("set", handleManagerUpdate));
      subscriptions.push(store.subscribe("delete", handleManagerUpdate));

      return () => {
        console.log("unsubscribe");
        for (const unsubscribe of subscriptions) {
          unsubscribe();
        }
      };
    };

    return { subscribe, accessProxy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useSyncExternalStore(singleton.subscribe, () => updateRef.current);

  return singleton.accessProxy;
};
