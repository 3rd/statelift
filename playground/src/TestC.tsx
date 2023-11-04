import React from "react";
import { useStore } from "reactlift";
import { testStore } from "./test-store";
import { useRenderCount } from "./devhooks";

export const TestC = () => {
  const renderCount = useRenderCount();

  const store = useStore(testStore);

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>C</h2>
      <p>renders: {renderCount}</p>
      <p>store.state.a: {store.nested.a}</p>
      <p>store.state.b: {store.nested.b}</p>
      <button onClick={() => store.nested.a++}>Increase A</button>
      <button onClick={() => store.nested.b++}>Increase B</button>
    </div>
  );
};
