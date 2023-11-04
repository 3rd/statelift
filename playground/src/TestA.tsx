import React from "react";
import { useStore } from "reactlift";
import { store } from "./store";
import { useRenderCount } from "./devhooks";

export const TestA = () => {
  const renderCount = useRenderCount();
  const state = useStore(store);

  const handleDirectClick = () => {
    state.nested.a++;
  };

  const handleActionClick = () => {
    state.incrementA(5);
  };

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>A</h2>
      <p>renders: {renderCount}</p>
      <p>state.nested.a: {state.nested.a}</p>
      <button onClick={handleDirectClick}>Direct</button>
      <button onClick={handleActionClick}>Action</button>
    </div>
  );
};
