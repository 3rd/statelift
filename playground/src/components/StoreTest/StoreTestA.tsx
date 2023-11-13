/* eslint-disable @typescript-eslint/no-magic-numbers */
import { useStore } from "statelift";
import { useRenderCount } from "../../hooks/useRenderCount";
import { Store } from "./StoreTest";

export interface StoreTestAProps {
  store: Store;
}

export const StoreTestA = ({ store }: StoreTestAProps) => {
  const state = useStore(store);
  const renderCount = useRenderCount();

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
