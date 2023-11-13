import { useStore } from "statelift";
import { useRenderCount } from "../../hooks/useRenderCount";
import { Store } from "./StoreTest";

export interface StoreTestCProps {
  store: Store;
}

export const StoreTestC = ({ store }: StoreTestCProps) => {
  const state = useStore(store);
  const renderCount = useRenderCount();

  return (
    <div style={{ border: "2px dashed #242424", padding: "1rem" }}>
      <h2>C</h2>
      <p>renders: {renderCount}</p>
      <p>state.nested.a: {state.nested.a}</p>
      <p>state.nested.b: {state.nested.b}</p>
      <button onClick={() => state.nested.a++}>Increase A</button>
      <button onClick={() => state.nested.b++}>Increase B</button>
    </div>
  );
};
