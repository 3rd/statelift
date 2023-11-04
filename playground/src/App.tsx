import React from "react";
import { useProxyState } from "reactlift";
import { useRenderCount } from "./devhooks";
import { testStore } from "./test-store";
import { Test } from "./Test";

const data = {
  nested: { a: 0, b: 0 },
};

const App = () => {
  const [count, setCount] = React.useState(0);
  const renderCount = useRenderCount();
  const simple = useProxyState(data);

  const handleIncrease = () => {
    setCount(count + 1);
  };

  const handleSimpleClickA = () => {
    simple.nested.a++;
  };

  const handleSimpleClickB = () => {
    simple.nested.b++;
  };

  return (
    <>
      <h1>App</h1>
      <div>App render count: {renderCount}</div>
      <button onClick={handleIncrease}>count: {count}</button>
      <div>
        <button onClick={handleSimpleClickA}>simple.a: {simple.nested.a}</button>
        <button onClick={handleSimpleClickB}>simple.b: {simple.nested.b}</button>
      </div>
      <testStore.Provider>
        <Test />
      </testStore.Provider>
    </>
  );
};

export { App };
