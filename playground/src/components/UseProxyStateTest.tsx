import React from "react";
import { useProxyState } from "reactlift";
import { useRenderCount } from "../hooks/useRenderCount";

const UseProxyStateTest = () => {
  const state = useProxyState({
    nested: { value: 0 },
  });
  const renderCount = useRenderCount();

  const handleIncrease = () => {
    state.nested.value++;
  };

  return (
    <>
      <h2>useProxyState()</h2>
      <div>renders: {renderCount}</div>
      <div>state.nested.value: {state.nested.value}</div>
      <button onClick={handleIncrease}>Increase</button>
    </>
  );
};

export { UseProxyStateTest };
