import React from "react";
import { useRenderCount } from "./hooks/useRenderCount";
import { UseProxyStateTest } from "./components/UseProxyStateTest";
import { StoreTest } from "./components/StoreTest";

const App = () => {
  const renderCount = useRenderCount();

  return (
    <>
      <h1>App</h1>
      <p>renders: {renderCount}</p>
      {/* <UseProxyStateTest /> */}
      <StoreTest />
    </>
  );
};

export { App };
