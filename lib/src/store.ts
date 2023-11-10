/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useRef, useSyncExternalStore } from "react";
import { createRootProxy } from "./proxy";
import { isFunction } from "./utils";

export type Store<T extends {}> = {
  state: T;
  registerConsumer: (id: ConsumerID, callback: () => void) => () => void;
};
export type Selector<T extends {}, R> = (state: T) => R;

type Consumer<T extends {}> = {
  proxy: T;
  destroy: () => void;
};
type ConsumerID = symbol;
type ConsumerTarget = {};
type ConsumerTargetProp = string | symbol;
type DependenciesMap = WeakMap<ConsumerTarget, Map<ConsumerTargetProp, Set<ConsumerID>>>;
type ConsumerCallbacksMap = WeakMap<ConsumerID, () => void>;
type ConsumerDependenciesMap = WeakMap<ConsumerID, Set<Set<ConsumerID>>>;

let currentConsumerId: ConsumerID | null = null;

export const createStoreFromBuilder = <T extends {}>(builder: (root: T) => T): Store<T> => {
  const targetDependenciesMap: DependenciesMap = new WeakMap();
  const consumerCallbacksMap: ConsumerCallbacksMap = new WeakMap();
  const consumerDependenciesMap: ConsumerDependenciesMap = new WeakMap();

  const notifyConsumers = (target: ConsumerTarget, prop: ConsumerTargetProp) => {
    const targetDependencies = targetDependenciesMap.get(target);
    if (!targetDependencies) return;

    const consumers = targetDependencies.get(prop);
    if (!consumers) return;

    for (const consumerId of consumers) {
      const callback = consumerCallbacksMap.get(consumerId);
      if (!callback) throw new Error("Consumer callback not found");
      callback();
    }
  };

  const state = createRootProxy(builder, {
    callbacks: {
      get: (target, prop, _receiver) => {
        if (!currentConsumerId) return;

        let targetDependencies = targetDependenciesMap.get(target);
        if (!targetDependencies) {
          targetDependencies = new Map();
          targetDependenciesMap.set(target, targetDependencies);
        }

        let propConsumers = targetDependencies.get(prop);
        if (!propConsumers) {
          propConsumers = new Set();
          targetDependencies.set(prop, propConsumers);
        }
        propConsumers.add(currentConsumerId);

        const consumerDependencies = consumerDependenciesMap.get(currentConsumerId);
        if (!consumerDependencies) throw new Error("Consumer dependencies not found");
        consumerDependencies.add(propConsumers);
      },
      set: (target, prop, _value, _receiver) => {
        notifyConsumers(target, prop);
      },
      deleteProperty: (target, prop) => {
        notifyConsumers(target, prop);
      },
    },
  });

  const registerConsumer = (id: ConsumerID, callback: () => void) => {
    consumerCallbacksMap.set(id, callback);
    consumerDependenciesMap.set(id, new Set());

    return () => {
      consumerCallbacksMap.delete(id);

      const dependencySets = consumerDependenciesMap.get(id);
      if (!dependencySets) return;

      for (const set of dependencySets) {
        set.delete(id);
      }
      consumerDependenciesMap.delete(id);
    };
  };

  return { state, registerConsumer };
};

export const createStore = <T extends {}>(target: T) => {
  const builder = isFunction(target) ? target : () => target;
  const store = createStoreFromBuilder(builder as (root: T) => T);
  return {
    state: store.state as T extends (...args: any[]) => any ? ReturnType<T> : T,
    registerConsumer: store.registerConsumer,
  };
};

let consumerIdCounter = 0;
export const createConsumer = <T extends {}>(
  store: Store<T>,
  callback: () => void
): Consumer<T> => {
  const consumerId = Symbol(`store-consumer:${consumerIdCounter++}`);

  const unregisterConsumer = store.registerConsumer(consumerId, callback);

  const handlers: ProxyHandler<{}> = {
    get(target, prop, receiver) {
      currentConsumerId = consumerId;

      try {
        const result = Reflect.get(target, prop, receiver);
        if (typeof result === "object" && result !== null && !(result instanceof Function)) {
          return new Proxy(result, handlers);
        }
        return result;
      } finally {
        currentConsumerId = null;
      }
    },
  };
  const { proxy, revoke } = Proxy.revocable(store.state, handlers);

  const destroy = () => {
    unregisterConsumer();
    revoke();
  };

  return {
    proxy: proxy as T,
    destroy,
  };
};

const initRefValue = {};

export function useStore<T extends {}>(store: Store<T>): T;
export function useStore<T extends {}, R>(store: Store<T>, selector: Selector<T, R>): R;
export function useStore<T extends {}, R>(store: Store<T>, selector?: Selector<T, R>) {
  const updateRef = useRef({});
  const valueRef = useRef<R | typeof initRefValue>(initRefValue as unknown as R);
  const selectorRef = useRef(selector);

  selectorRef.current = selector;

  const memoizedConsumer = useMemo(() => {
    let referenceCount = 0;
    let callbackRef = () => {};

    const consumer = createConsumer(store, () => {
      if (selectorRef.current) {
        const newValue = selectorRef.current(consumer.proxy as T);
        if (Object.is(newValue, valueRef.current)) return;
        valueRef.current = newValue;
      }
      updateRef.current = {};
      callbackRef();
    });

    const subscribe = (callback: () => void) => {
      callbackRef = callback;
      referenceCount++;

      return () => {
        referenceCount--;

        setTimeout(() => {
          if (referenceCount === 0) {
            consumer.destroy();
          }
        }, 0);
      };
    };

    return { subscribe, proxy: consumer.proxy };
  }, [store]);

  useSyncExternalStore(memoizedConsumer.subscribe, () => updateRef.current);

  if (selectorRef.current) {
    if (valueRef.current === initRefValue) {
      valueRef.current = selectorRef.current(memoizedConsumer.proxy);
    }
    return valueRef.current;
  }

  return memoizedConsumer.proxy as T;
}
