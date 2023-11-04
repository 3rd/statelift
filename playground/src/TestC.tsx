import React from "react";
import { useStore } from "reactlift";
import { store } from "./store";
import { useRenderCount } from "./devhooks";

export const TestC = () => {
  const renderCount = useRenderCount();
  const state = useStore(store);

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>C</h2>
      <p>renders: {renderCount}</p>
      <p>state.state.a: {state.nested.a}</p>
      <p>state.state.b: {state.nested.b}</p>
      <button onClick={() => state.nested.a++}>Increase A</button>
      <button onClick={() => state.nested.b++}>Increase B</button>
    </div>
  );
};
