import { useStore } from "statelift";
import { useRenderCount } from "../../hooks/useRenderCount";
import { Store } from "./StoreTest";

export interface StoreTestDProps {
  store: Store;
}

export const StoreTestD = ({ store }: StoreTestDProps) => {
  const state = useStore(store);
  const renderCount = useRenderCount();

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>D</h2>
      <p>renders: {renderCount}</p>
      <p>store.doubleA: {state.doubleA}</p>
    </div>
  );
};
