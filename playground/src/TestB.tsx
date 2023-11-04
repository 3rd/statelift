import React from "react";
import { useStore } from "reactlift";
import { testStore } from "./test-store";
import { useRenderCount } from "./devhooks";

export const TestB = () => {
  const renderCount = useRenderCount();

  const store = useStore(testStore);

  const handleDirectClick = () => {
    store.nested.b++;
  };

  const handleActionClick = () => {
    store.incrementB(5);
  };

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>B</h2>
      <p>renders: {renderCount}</p>
      <p>store.state.b: {store.nested.b}</p>
      <button onClick={handleDirectClick}>Direct</button>
      <button onClick={handleActionClick}>Action</button>
    </div>
  );
};
