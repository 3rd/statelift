import { useState } from "react";
import { useRenderCount } from "../../hooks/useRenderCount";
import { StoreTestA } from "./StoreTestA";
import { StoreTestB } from "./StoreTestB";
import { StoreTestC } from "./StoreTestC";
import { StoreTestD } from "./StoreTestD";
import {
  createSelfReferencingStoreWithRootArg,
  createSelfReferencingStoreWithStoreInstance,
  createSimpleStore,
} from "../../stores";

const stores = {
  simpleStore: createSimpleStore(),
  selfReferencingStoreWithRootArg: createSelfReferencingStoreWithRootArg(),
  selfReferencingStoreWithStoreInstance: createSelfReferencingStoreWithStoreInstance(),
};

export type Store = (typeof stores)[keyof typeof stores];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).stores = stores;

export const StoreTest = () => {
  const renderCount = useRenderCount();
  const [storeKey, setStoreKey] = useState<keyof typeof stores>("selfReferencingStoreWithRootArg");

  const store = stores[storeKey];

  return (
    <>
      <h2>StoreTest</h2>
      <div>renders: {renderCount}</div>
      <label htmlFor="store">store:</label>
      <select
        id="store"
        value={storeKey}
        onChange={(e) => setStoreKey(e.target.value as keyof typeof stores)}
      >
        {Object.keys(stores).map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </select>

      <div style={{ display: "flex", gap: "1rem" }}>
        <StoreTestA store={store} />
        <StoreTestB store={store} />
        <StoreTestC store={store} />
        <StoreTestD store={store} />
      </div>
    </>
  );
};
