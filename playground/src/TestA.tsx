import React from "react";
import { useStore } from "reactlift";
import { testStore } from "./test-store";
import { useRenderCount } from "./devhooks";

export const TestA = () => {
  const renderCount = useRenderCount();

  const store = useStore(testStore);

  const handleDirectClick = () => {
    store.state.nested.a++;
  };

  const handleActionClick = () => {
    store.actions.incrementA(5);
  };

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>A</h2>
      <p>renders: {renderCount}</p>
      <p>store.state.a: {store.state.nested.a}</p>
      <button onClick={handleDirectClick}>Direct</button>
      <button onClick={handleActionClick}>Action</button>
    </div>
  );
};
