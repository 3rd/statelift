import React from "react";
import { useProxyState } from "./lib";
import { useRenderCount } from "./devhooks";

const data = {
  simpleState: { nested: { a: 0, b: 0 } },
};

const App = () => {
  const [count, setCount] = React.useState(0);
  const renderCount = useRenderCount();
  const simple = useProxyState(JSON.parse(JSON.stringify(data.simpleState)));

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
      <div>App render count: {renderCount}</div>
      <button onClick={handleIncrease}>count: {count}</button>
      <div>
        <button onClick={handleSimpleClickA}>simple.a: {simple.nested.a}</button>
        <button onClick={handleSimpleClickB}>simple.b: {simple.nested.b}</button>
      </div>
    </>
  );
};

export { App };
