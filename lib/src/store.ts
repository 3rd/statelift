/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useRef, useSyncExternalStore } from "react";
import { ProxyCacheValue, ProxyCallbacks, createDeepProxy } from "./proxy";
import { isFunction } from "./utils";

type StoreWatchers = {
  [K in keyof ProxyCallbacks]: Set<ProxyCallbacks[K]>;
};

interface Store<T extends {}> {
  state: T;
  subscribe: <K extends keyof StoreWatchers>(event: K, watcher: ProxyCallbacks[K]) => () => void;
}

type StoreOptions<T extends {}> = {
  targetOrBuilder: T | ((root: T) => T);
};

class StoreManager<T extends {}> {
  state: T;
  watchers: StoreWatchers = {
    get: new Set(),
    set: new Set(),
    delete: new Set(),
  };

  constructor({ targetOrBuilder }: StoreOptions<T>) {
    if (isFunction(targetOrBuilder)) {
      let target = {} as T;
      const proxy = new Proxy({} as T, {
        get(_, key) {
          return Reflect.get(target, key, target);
        },
        set(_, key, value) {
          Reflect.set(target, key, value, target);
          return true;
        },
        deleteProperty(_, key) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete target[key as keyof T];
          return true;
        },
      });
      const builtState = (targetOrBuilder as (root: T) => T)(proxy);
      target = createDeepProxy(builtState, {
        callbacks: {
          get: this.handleGet,
          set: this.handleSet,
          delete: this.handleDelete,
        },
      }).instance;
      this.state = target as any;
    } else {
      this.state = createDeepProxy(targetOrBuilder, {
        callbacks: {
          get: this.handleGet,
          set: this.handleSet,
          delete: this.handleDelete,
        },
      }).instance as any;
    }
  }

  private handleGet = (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: any) => {
    console.log("@manager get", target, key);
    for (const watcher of this.watchers.get) {
      watcher(proxy, target, key, value);
    }
  };

  private handleSet = (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: any) => {
    // console.log("@manager set", target, key, value);
    for (const watcher of this.watchers.set) {
      watcher(proxy, target, key, value);
    }
  };

  private handleDelete = (proxy: ProxyCacheValue, target: {}, key: string | symbol) => {
    // console.log("@manager delete", target, key);
    for (const watcher of this.watchers.delete) {
      watcher(proxy, target, key);
    }
  };

  subscribe: Store<T>["subscribe"] = (event, watcher) => {
    this.watchers[event].add(watcher);
    return () => {
      this.watchers[event].delete(watcher);
    };
  };
}

export const createStore = <T extends {}>(target: T) => {
  const manager = new StoreManager({ targetOrBuilder: target });

  return {
    state: manager.state as T extends (...args: any[]) => any ? ReturnType<T> : T,
    subscribe: manager.subscribe.bind(manager),
  };
};

let useStoreHelperCount = 0;
export const useStore = <T extends {}>(store: Store<T>) => {
  const updateRef = useRef({});
  const observedPropertiesRef = useRef<WeakMap<any, Set<string | symbol>>>(new WeakMap());

  const singleton = useMemo(() => {
    const handleGet = (proxy: ProxyCacheValue, target: any, key: string | symbol) => {
      console.log("@useStore get", { proxy, target, key });
      if (observedPropertiesRef.current.has(target)) {
        observedPropertiesRef.current.get(target)!.add(key);
      } else {
        observedPropertiesRef.current.set(target, new Set([key]));
      }
    };

    const createHandleManagerUpdate =
      (callback: () => void) => (proxy: ProxyCacheValue, _target: any, key: string | symbol) => {
        console.log("@useStore handle manager update", { proxy, _target, key });
        const observedProperties = observedPropertiesRef.current.get(proxy.instance);
        if (!observedProperties || !observedProperties.has(key)) return;
        updateRef.current = {};
        callback();
      };

    const accessProxy = createDeepProxy(store.state, {
      rootSymbol: Symbol(`useStore:${++useStoreHelperCount}`),
      callbacks: {
        get: handleGet,
      },
    });

    const subscribe = (callback: () => void) => {
      const subscriptions: (() => void)[] = [];
      const handleManagerUpdate = createHandleManagerUpdate(callback);
      subscriptions.push(store.subscribe("set", handleManagerUpdate));
      subscriptions.push(store.subscribe("delete", handleManagerUpdate));

      return () => {
        for (const unsubscribe of subscriptions) {
          unsubscribe();
        }
      };
    };

    return { subscribe, accessProxy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  useSyncExternalStore(singleton.subscribe, () => updateRef.current);

  return singleton.accessProxy.instance;
};
