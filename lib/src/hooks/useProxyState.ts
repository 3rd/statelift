import { useReducer, useRef } from "react";
import { createDeepProxy, isUncachedGetter } from "../proxy";

export const useProxyState = <T extends {}>(target: T): T => {
  const state = useRef<T | null>(null);
  const [, forceUpdate] = useReducer(() => ({}), {});

  if (state.current === null) {
    // Every mutation advances the cache version because this hook tracks no individual properties.
    let version = 0;
    const knownGetters = new WeakMap<{}, Map<string | symbol, () => unknown>>();
    const cellCache = new WeakMap<{}, Map<string | symbol, { version: number; value: unknown }>>();
    // Property-level evaluation allows one getter function to be shared across nodes.
    const evaluating = new WeakMap<{}, Set<string | symbol>>();

    const reconcileGetter = (node: {}, prop: string | symbol) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(node, prop);
      const getter = descriptor?.get;
      const eligible = getter && !descriptor.set && !isUncachedGetter(getter);
      let getters = knownGetters.get(node);
      if (eligible) {
        if (!getters) {
          getters = new Map();
          knownGetters.set(node, getters);
        }
        if (getters.get(prop) === getter) return;
        getters.set(prop, getter);
      } else if (getters) {
        getters.delete(prop);
        if (getters.size === 0) knownGetters.delete(node);
      }

      const cells = cellCache.get(node);
      cells?.delete(prop);
      if (cells?.size === 0) cellCache.delete(node);
    };

    const scanForGetters = (node: {}) => {
      for (const prop of Reflect.ownKeys(node)) reconcileGetter(node, prop);
    };

    const invalidate = () => {
      version++;
      forceUpdate();
    };

    state.current = createDeepProxy(target, {
      callbacks: {
        set: invalidate,
        defineProperty: ({ target: node, prop }) => {
          reconcileGetter(node, prop);
          invalidate();
        },
        deleteProperty: (node, prop) => {
          reconcileGetter(node, prop);
          invalidate();
        },
        arrayMethodComplete: invalidate,
        onWrap: scanForGetters,
        resolveComputed: (node, prop, targetProxy) => {
          const getter = knownGetters.get(node)?.get(prop);
          if (!getter) return undefined;

          let cells = cellCache.get(node);
          if (!cells) {
            cells = new Map();
            cellCache.set(node, cells);
          }
          const cell = cells.get(prop);
          if (cell && cell.version === version) return { value: cell.value };

          const alreadyEvaluating = evaluating.get(node);
          if (alreadyEvaluating?.has(prop)) {
            throw new Error(`statelift: computed cycle detected at "${String(prop)}"`);
          }
          const evaluatingProps = alreadyEvaluating ?? new Set<string | symbol>();
          if (alreadyEvaluating === undefined) evaluating.set(node, evaluatingProps);
          evaluatingProps.add(prop);
          try {
            const value = getter.call(targetProxy);
            cells.set(prop, { version, value });
            return { value };
          } finally {
            evaluatingProps.delete(prop);
            if (evaluatingProps.size === 0) evaluating.delete(node);
          }
        },
      },
    });
  }

  return state.current;
};
