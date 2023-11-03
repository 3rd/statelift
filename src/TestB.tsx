import React from "react";
import { useStore } from "./lib";
import { testStore } from "./test-store";
import { useRenderCount } from "./devhooks";

export const TestB = () => {
  const renderCount = useRenderCount();

  const store = useStore(testStore);

  const handleDirectClick = () => {
    store.state.nested.b++;
  };

  const handleActionClick = () => {
    store.actions.incrementB(5);
  };

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>B</h2>
      <p>renders: {renderCount}</p>
      <p>store.state.b: {store.state.nested.b}</p>
      <button onClick={handleDirectClick}>Direct</button>
      <button onClick={handleActionClick}>Action</button>
    </div>
  );
};
