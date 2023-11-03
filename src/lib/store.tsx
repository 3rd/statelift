/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { createContext, useMemo, useRef, useSyncExternalStore } from "react";
import { ProxyCacheValue, createDeepProxy } from "./proxy";

const STORE_INTERNAL = Symbol("STORE_INTERNAL");

type Computable<T extends {}> = (state: T) => unknown;
type Computables<T extends {}> = Record<string, Computable<T>> & { [K in keyof T]?: never };
type ComputedState<T extends {}, C extends Computables<T>> = {
  [K in keyof C]: ReturnType<C[K]>;
};

type Action<T extends {}, C extends Computables<T>> = (
  context: { state: T; computed: ComputedState<T, C> },
  ...args: any[]
) => void;
type Actions<T extends {}, C extends Computables<T>> = Record<string, Action<T, C>>;
type WrappedActions<A extends Actions<any, any>> = {
  [K in keyof A]: A[K] extends (context: any, ...args: infer P) => infer R ? (...args: P) => R : never;
};

type Store<T extends {}, C extends Computables<T>, A extends Actions<T, C>> = {
  state: T;
  computed: C;
  actions: WrappedActions<A>;
  Provider: React.FC<{ children: React.ReactNode }>;
  [STORE_INTERNAL]: {
    manager: StoreManager<T, C, A>;
    context: React.Context<Store<T, C, A>>;
  };
};

interface StoreOptions<T extends {}, C extends Computables<T>, A extends Actions<T, C>> {
  target: T;
  computables?: C;
  actions?: A;
}

class StoreManager<
  TState extends {},
  TComputables extends Computables<TState>,
  TActions extends Actions<TState, TComputables>,
> {
  state: TState;
  computables = {} as TComputables;
  actions = {} as TActions;
  watchers = {
    get: new Set<(proxy: ProxyCacheValue, target: {}, key: string | symbol, value: any) => void>(),
    set: new Set<(proxy: ProxyCacheValue, target: {}, key: string | symbol, value: any) => void>(),
    delete: new Set<(proxy: ProxyCacheValue, target: {}, key: string | symbol) => void>(),
  };

  constructor({ target, computables, actions }: StoreOptions<TState, TComputables, TActions>) {
    this.state = createDeepProxy(target, {
      callbacks: {
        get: this.handleGet,
        set: this.handleSet,
        delete: this.handleDelete,
      },
    });
    if (computables) this.computables = computables;
    if (actions) this.actions = actions;
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

export const createStore = <T extends {}, C extends Computables<T>, A extends Actions<T, C>>(
  target: T,
  options?: { computed?: C; actions?: A }
): Store<T, C, A> => {
  const manager = new StoreManager<T, C, A>({
    target,
    computables: options?.computed,
    actions: options?.actions,
  });

  const computeState = <TS extends {}, TC extends Computables<TS>>(
    state: TS,
    computables: TC
  ): ComputedState<TS, TC> => {
    return Object.fromEntries(
      Object.entries(computables).map(([key, computable]) => [key, computable(state)])
    ) as ComputedState<TS, TC>;
  };

  const wrappedActions = Object.fromEntries(
    Object.entries(manager.actions).map(([key, action]) => {
      return [
        key,
        (...args: any[]) => {
          const computed = computeState(manager.state, manager.computables);
          action({ state: manager.state, computed }, ...args);
        },
      ];
    })
  ) as WrappedActions<A>;

  const api = {
    state: manager.state,
    actions: wrappedActions,
    computed: manager.computables,
  } as Store<T, C, A>;

  const context = createContext<Store<T, C, A>>(api);
  api.Provider = ({ children }: { children: React.ReactNode }) => {
    return <context.Provider value={api}>{children}</context.Provider>;
  };

  api[STORE_INTERNAL] = {
    manager,
    context,
  };

  return api;
};

let useStoreHelperCount = 0;
export const useStore = <T extends {}, C extends Computables<T>, A extends Actions<T, C>>(store: Store<T, C, A>) => {
  const context = React.useContext(store[STORE_INTERNAL].context);
  const updateRef = useRef({});

  const singleton = useMemo(() => {
    const symbol = Symbol(`useStore:${++useStoreHelperCount}`);
    const manager = store[STORE_INTERNAL].manager;
    const observedPropertiesMap = new WeakMap<any, Set<string | symbol>>();

    const handleGet = (_: ProxyCacheValue, target: any, key: string | symbol) => {
      if (observedPropertiesMap.has(target)) {
        observedPropertiesMap.get(target)!.add(key);
      } else {
        observedPropertiesMap.set(target, new Set([key]));
      }
    };

    const createHandleManagerUpdate =
      (callback: () => void) => (proxy: ProxyCacheValue, _target: any, key: string | symbol) => {
        const observedProperties = observedPropertiesMap.get(proxy.instance);
        if (!observedProperties || !observedProperties.has(key)) return;
        updateRef.current = {};
        callback();
      };

    const accessProxy = createDeepProxy(manager.state, {
      rootSymbol: symbol,
      callbacks: {
        get: handleGet,
      },
    }) as unknown as T;

    const subscribe = (callback: () => void) => {
      const subscriptions: (() => void)[] = [];
      const handleManagerUpdate = createHandleManagerUpdate(callback);
      subscriptions.push(manager.subscribe("set", handleManagerUpdate));
      subscriptions.push(manager.subscribe("delete", handleManagerUpdate));

      return () => {
        for (const unsubscribe of subscriptions) {
          unsubscribe();
        }
      };
    };

    return { manager, subscribe, accessProxy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useSyncExternalStore(singleton.subscribe, () => updateRef.current);

  return {
    state: singleton.accessProxy,
    actions: context.actions,
    computed: context.computed,
  };
};
