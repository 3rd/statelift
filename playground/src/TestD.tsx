import React from "react";
import { useStore } from "reactlift";
import { testStore } from "./test-store";
import { useRenderCount } from "./devhooks";

export const TestD = () => {
  const renderCount = useRenderCount();

  const store = useStore(testStore);

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>D</h2>
      <p>renders: {renderCount}</p>
      <p>store.state.doubleA: {store.doubleA}</p>
    </div>
  );
};
