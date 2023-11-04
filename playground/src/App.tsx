import React from "react";
import { useProxyState } from "reactlift";
import { useRenderCount } from "./devhooks";
import { Test } from "./Test";

const data = {
  simple: { a: 0, b: 0 },
};

const App = () => {
  const [count, setCount] = React.useState(0);
  const renderCount = useRenderCount();
  const simple = useProxyState(data);

  const handleIncrease = () => {
    setCount(count + 1);
  };

  const handleSimpleClickA = () => {
    simple.simple.a++;
  };

  const handleSimpleClickB = () => {
    simple.simple.b++;
  };

  return (
    <>
      <h1>App</h1>
      <div>App render count: {renderCount}</div>
      <button onClick={handleIncrease}>count: {count}</button>
      <div>
        <button onClick={handleSimpleClickA}>simple.a: {simple.simple.a}</button>
        <button onClick={handleSimpleClickB}>simple.b: {simple.simple.b}</button>
      </div>
      <Test />
    </>
  );
};

export { App };
