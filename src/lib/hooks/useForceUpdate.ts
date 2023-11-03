import { useReducer } from "react";

export const useForceUpdate = () => {
  const [, forceUpdate] = useReducer(() => ({}), {});
  return forceUpdate;
};
