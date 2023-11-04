import React from "react";
import { useStore } from "reactlift";
import { store } from "./store";
import { useRenderCount } from "./devhooks";

export const TestB = () => {
  const renderCount = useRenderCount();
  const state = useStore(store);

  const handleDirectClick = () => {
    state.nested.b++;
  };

  const handleActionClick = () => {
    state.incrementB(5);
  };

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>B</h2>
      <p>renders: {renderCount}</p>
      <p>state.state.b: {state.nested.b}</p>
      <button onClick={handleDirectClick}>Direct</button>
      <button onClick={handleActionClick}>Action</button>
    </div>
  );
};
