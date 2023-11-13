import { Navigation } from "../components/Nav";
import { StoreTest } from "../components/StoreTest";
import { UseProxyStateTest } from "../components/UseProxyStateTest";
import { useRenderCount } from "../hooks/useRenderCount";

export const Home = () => {
  const renderCount = useRenderCount();

  return (
    <>
      <Navigation />
      <h1>App</h1>
      <p>renders: {renderCount}</p>
      <p>
        check <code>window.stores</code> for direct store access
      </p>
      <UseProxyStateTest />
      <StoreTest />
    </>
  );
};
