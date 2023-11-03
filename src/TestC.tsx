import React from "react";
import { useStore } from "./lib";
import { testStore } from "./test-store";
import { useRenderCount } from "./devhooks";

export const TestC = () => {
  const renderCount = useRenderCount();

  const store = useStore(testStore);

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>C</h2>
      <p>renders: {renderCount}</p>
      <p>store.state.a: {store.state.nested.a}</p>
      <p>store.state.b: {store.state.nested.b}</p>
      <button onClick={() => store.state.nested.a++}>Increase A</button>
      <button onClick={() => store.state.nested.b++}>Increase B</button>
    </div>
  );
};
