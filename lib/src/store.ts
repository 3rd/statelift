/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useRef, useSyncExternalStore } from "react";
import {
  ProxyCacheValue,
  ProxyCallbacks,
  createDeepProxy,
  createRootProxy,
  unwrapProxy,
} from "./proxy";
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
  proxy: ProxyCacheValue<T>;
  watchers: StoreWatchers = {
    get: new Set(),
    set: new Set(),
    delete: new Set(),
  };

  constructor({ targetOrBuilder }: StoreOptions<T>) {
    if (isFunction(targetOrBuilder)) {
      const root = createRootProxy(targetOrBuilder as (root: T) => T, {
        callbacks: {
          set: this.handleRootSet,
        },
      });

      this.proxy = createDeepProxy(root, {
        rootSymbol: Symbol("computed-store"),
        callbacks: {
          get: this.handleGet,
          set: this.handleSet,
          delete: this.handleDelete,
        },
      });
    } else {
      this.proxy = createDeepProxy(targetOrBuilder, {
        callbacks: {
          get: this.handleGet,
          set: this.handleSet,
          delete: this.handleDelete,
        },
      }) as ProxyCacheValue<T>;
    }
  }

  get state() {
    return this.proxy.instance;
  }

  private handleGet = (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: any) => {
    // console.log("@manager get", target, key);
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

  private handleRootSet = (target: {}, prop: string | symbol, value: any) => {
    // console.log("@manager root set", target, key, value);
    for (const watcher of this.watchers.set) {
      watcher(this.proxy, target, prop, value);
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

type UseStoreOptions = {
  label?: string;
};

export const useStore = <T extends {}>(store: Store<T>, opts?: UseStoreOptions) => {
  const updateRef = useRef({});
  const observedPropertiesRef = useRef<Map<any, Set<string | symbol>>>(new Map());

  // if (opts?.label) console.log(`---------- @useStore ${opts.label} -----------`);

  const singleton = useMemo(() => {
    const handleGet = (_: ProxyCacheValue, target: any, key: string | symbol) => {
      const unwrappedTarget = unwrapProxy(target);
      // console.log("@useStore get", { proxy, target, key, unwrappedTarget });

      if (observedPropertiesRef.current.has(unwrappedTarget)) {
        observedPropertiesRef.current.get(unwrappedTarget)!.add(key);
      } else {
        observedPropertiesRef.current.set(unwrappedTarget, new Set([key]));
      }
    };

    const createHandleManagerUpdate =
      (callback: () => void) => (_: ProxyCacheValue, target: any, key: string | symbol) => {
        const unwrappedTarget = unwrapProxy(target);

        // console.log("@useStore handle manager update", { target, key, unwrappedTarget });
        // console.log("DEPS:", observedPropertiesRef.current.entries());
        const observedProperties = observedPropertiesRef.current.get(unwrappedTarget);
        if (!observedProperties || !observedProperties.has(key)) return;
        updateRef.current = {};
        callback();
      };

    const accessProxy = createDeepProxy(store.state, {
      // eslint-disable-next-line sonarjs/no-nested-template-literals
      rootSymbol: Symbol(`useStore:${opts?.label ? `${opts.label}:` : ""}${++useStoreHelperCount}`),
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
