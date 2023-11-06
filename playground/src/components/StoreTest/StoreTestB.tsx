import React from "react";
import { useStore } from "../../../../lib/src/store";
import { useRenderCount } from "../../hooks/useRenderCount";
import { Store } from "./StoreTest";

export interface StoreTestBProps {
  store: Store;
}

export const StoreTestB = ({ store }: StoreTestBProps) => {
  const state = useStore(store);
  const renderCount = useRenderCount();

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
      <p>state.nested.b: {state.nested.b}</p>
      <button onClick={handleDirectClick}>Direct</button>
      <button onClick={handleActionClick}>Action</button>
    </div>
  );
};
