import { useReducer, useRef } from "react";
import { createDeepProxy } from "../proxy";

export const useProxyState = <T extends {}>(target: T): T => {
  const state = useRef<T>();
  const [, forceUpdate] = useReducer(() => ({}), {});

  if (!state.current) {
    state.current = createDeepProxy(target, {
      isRoot: true,
      callbacks: { set: forceUpdate },
    }).instance;
  }

  return state.current;
};
