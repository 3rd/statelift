import { useReducer, useRef } from "react";
import { createDeepProxy } from "../proxy";

export const useProxyState = <T extends {}>(target: T): T => {
  const state = useRef<T | null>(null);
  const [, forceUpdate] = useReducer(() => ({}), {});

  if (!state.current) {
    state.current = createDeepProxy(target, {
      callbacks: { set: forceUpdate, deleteProperty: forceUpdate },
    });
  }

  return state.current!;
};
