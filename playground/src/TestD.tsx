import React from "react";
import { useStore } from "reactlift";
import { store } from "./store";
import { useRenderCount } from "./devhooks";

export const TestD = () => {
  const renderCount = useRenderCount();
  const state = useStore(store);

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>D</h2>
      <p>renders: {renderCount}</p>
      <p>store.state.doubleA: {state.doubleA}</p>
    </div>
  );
};
