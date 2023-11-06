import React, { useState } from "react";
import { useRenderCount } from "../../hooks/useRenderCount";
import * as stores from "../../stores";
import { StoreTestA } from "./StoreTestA";
import { StoreTestB } from "./StoreTestB";
import { StoreTestC } from "./StoreTestC";
import { StoreTestD } from "./StoreTestD";

type Mutable<T> = T & {
  -readonly [P in keyof T]: T[P];
};

type Stores = Mutable<typeof stores>;

const mappedStores = Object.keys(stores).reduce(
  (acc, key) => {
    acc[key as keyof typeof stores] = stores[key as keyof typeof stores];
    return acc;
  },
  {} as { [K in keyof Stores]: Stores[K] }
);

export const StoreTest = () => {
  const renderCount = useRenderCount();
  const [storeKey, setStoreKey] = useState<keyof Stores>("selfReferencingStoreWithStoreInstance");

  const store: stores.Store = mappedStores[storeKey];

  return (
    <>
      <h2>StoreTest</h2>
      <div>renders: {renderCount}</div>
      <label htmlFor="store">store:</label>
      <select
        id="store"
        value={storeKey}
        onChange={(e) => setStoreKey(e.target.value as keyof Stores)}
      >
        {Object.keys(mappedStores).map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </select>

      <div style={{ display: "flex", gap: "1rem" }}>
        {/* <StoreTestA store={store} /> */}
        {/* <StoreTestB store={store} /> */}
        {/* <StoreTestC store={store} /> */}
        <StoreTestD store={store} />
      </div>
    </>
  );
};
