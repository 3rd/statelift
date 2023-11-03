import { useRef } from "react";
import { useForceUpdate } from "../../hooks/useForceUpdate";
import { createDeepProxy } from "../../proxy";

export const useProxyState = <T extends {}>(target: T): T => {
  const state = useRef(target);
  const forceUpdate = useForceUpdate();

  const proxy = useRef(createDeepProxy(state.current, { onSet: forceUpdate }) as T);
  return proxy.current;
};
