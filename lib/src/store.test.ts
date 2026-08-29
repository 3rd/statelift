import { Activity, createElement, useEffect, useRef } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { Selector, Store, UseStoreOptions } from "./store";
import { proxyMap, type ProxyMap, proxySet, type ProxySet } from "./collections";
import {
  activatePersistence,
  disposePersistence,
  hasHydrated,
  PERSIST_FORMAT,
  persistReady,
  rehydrate,
} from "./persist";
import { unwrapProxy } from "./proxy";
import { createStoreContext, createUseStore, useStore } from "./react";
import { shallow } from "./shallow";
import {
  batch,
  computed,
  createConsumer,
  createStore,
  dehydrate,
  getActionLabel,
  hydrate,
  restore,
  snapshot,
  subscribe,
  uncached,
} from "./store";

const persistenceEnvelope = (state: unknown, version = 0) => [PERSIST_FORMAT, version, state];
const serializedPersistenceEnvelope = (state: unknown, version = 0) =>
  JSON.stringify(persistenceEnvelope(state, version));
const readPersistedValue = (key: string) => {
  const value = localStorage.getItem(key);
  if (value === null) throw new Error(`expected persisted value for "${key}"`);
  return value;
};

const createSimpleStore = () =>
  createStore({
    nested: { a: 3 },
  });

const useFullStoreWithRenderCount = <T extends {}>(store: Store<T>) => {
  const state = useStore(store);
  const count = useRef(0);
  count.current++;
  return { count: count.current, state };
};

const useStoreWithRenderCount = <T extends {}, R>(
  store: Store<T>,
  selector: Selector<T, R>,
  options?: UseStoreOptions<R>,
) => {
  const state = useStore(store, selector, options);
  const count = useRef(0);
  count.current++;
  return { count: count.current, state };
};

describe("createStore", () => {
  it("returns locked root functions without action wrapping", () => {
    const action = () => "action";
    const source = { action };
    Object.defineProperty(source, "action", {
      value: action,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    const store = createStore(source);

    expect(store.state.action).toBe(action);
    expect(store.state.action()).toBe("action");
  });
});

describe("createConsumer", () => {
  it("calls the callback when the accessed data changes", () => {
    const store = createStore({ a: 1, b: 2 });

    const callback = mock();
    const consumer = createConsumer(store, callback);

    expect(consumer.proxy.a).toEqual(1);
    expect(callback).toHaveBeenCalledTimes(0);

    store.state.b = 2;
    expect(store.state.b).toEqual(2);
    expect(callback).toHaveBeenCalledTimes(0);

    store.state.a = 2;
    expect(store.state.a).toEqual(2);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not call the callback when the accessed data is set to the same value", () => {
    const store = createStore({ a: 1, b: 2 });

    const callback = mock();
    const consumer = createConsumer(store, callback);

    expect(consumer.proxy.a).toEqual(1);
    expect(callback).toHaveBeenCalledTimes(0);

    store.state.a = 2;
    expect(store.state.a).toEqual(2);
    expect(callback).toHaveBeenCalledTimes(1);

    store.state.a = 2;
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("calls the callback when accessed getter dependencies change", () => {
    const store = createStore({
      a: 5,
      b: 5,
      get sum() {
        return this.a + this.b;
      },
    });

    const callback = mock();
    const consumer = createConsumer(store, callback);

    store.state.a = 10;
    expect(store.state.sum).toEqual(15);
    expect(callback).toHaveBeenCalledTimes(0);

    expect(consumer.proxy.sum).toEqual(15);
    expect(callback).toHaveBeenCalledTimes(0);

    store.state.a = 20;
    expect(store.state.sum).toEqual(25);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("tracks new root dependencies when a repeated accessor read changes branches", () => {
    type BranchState = {
      useAlternate: boolean;
      primary: number;
      alternate: number;
      current: number;
    };
    const store = createStore((root: BranchState) => ({
      useAlternate: false,
      primary: 1,
      alternate: 2,
      get current() {
        return root.useAlternate ? root.alternate : root.primary;
      },
      set current(value) {
        root.primary = value;
      },
    }));
    const callback = mock();
    const consumer = createConsumer(store, callback);

    expect(consumer.proxy.current).toBe(1);
    store.state.useAlternate = true;
    expect(callback).toHaveBeenCalledTimes(1);

    callback.mockClear();
    expect(consumer.proxy.current).toBe(2);
    store.state.alternate = 3;

    expect(callback).toHaveBeenCalledTimes(1);
    consumer.destroy();
  });

  it("destroys the consumer", () => {
    const store = createStore({ a: 1, b: 2 });
    const consumer = createConsumer(store, mock());

    expect(consumer.proxy.a).toEqual(1);

    consumer.destroy();
    expect(() => consumer.proxy.a).toThrow(TypeError);
  });
});

describe("store definitions", () => {
  it("supports root-referencing builders", () => {
    type State = {
      top: number;
      nested: {
        doubleTop: number;
        increaseTop: () => void;
      };
    };
    const store = createStore((root: State) => ({
      top: 2,
      nested: {
        get doubleTop() {
          return root.top * 2;
        },
        increaseTop() {
          root.top = 3;
        },
      },
    }));

    expect(store.state.nested.doubleTop).toBe(4);
    store.state.top = 10;
    expect(store.state.nested.doubleTop).toBe(20);
    store.state.nested.increaseTop();
    expect(store.state.top).toBe(3);
  });
});

describe("ownKeys dependency tracking", () => {
  it("rerenders when a new property is added and consumer used Object.keys()", () => {
    const store = createStore<{ items: Record<string, number> }>({ items: { a: 1, b: 2 } });
    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => Object.keys(state.items)));

    expect(result.current.state).toEqual(["a", "b"]);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.items.c = 3;
    });

    expect(result.current.state).toEqual(["a", "b", "c"]);
    expect(result.current.count).toEqual(2);
  });

  it("rerenders when a property is deleted and consumer used Object.keys()", () => {
    const store = createStore<{ items: Record<string, number | undefined> }>({ items: { a: 1, b: 2, c: 3 } });
    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => Object.keys(state.items)));

    expect(result.current.state).toEqual(["a", "b", "c"]);
    expect(result.current.count).toEqual(1);

    act(() => {
      delete store.state.items.b;
    });

    expect(result.current.state).toEqual(["a", "c"]);
    expect(result.current.count).toEqual(2);
  });

  it("does not rerender when property value changes but keys stay the same", () => {
    const store = createStore<{ items: Record<string, number> }>({ items: { a: 1, b: 2 } });
    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => Object.keys(state.items)));

    expect(result.current.state).toEqual(["a", "b"]);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.items.a = 100;
    });

    expect(result.current.count).toEqual(1);
  });

  it("routes descriptor changes to key, index, and length consumers", () => {
    const source = { visible: 1, hidden: 2 };
    Object.defineProperty(source, "hidden", {
      configurable: true,
      enumerable: false,
      value: 2,
      writable: true,
    });
    const store = createStore(source);
    const keys = renderHook(() => useStoreWithRenderCount(store, (state) => Object.keys(state)));
    const hidden = renderHook(() => useStoreWithRenderCount(store, (state) => state.hidden));

    act(() => {
      Object.defineProperty(store.state, "hidden", { enumerable: true });
    });

    expect(keys.result.current.state).toEqual(["visible", "hidden"]);
    expect(keys.result.current.count).toEqual(2);
    expect(hidden.result.current.count).toEqual(1);

    const arrayStore = createStore({ items: [1] });
    const index = renderHook(() => useStoreWithRenderCount(arrayStore, (state) => state.items[3]));
    const length = renderHook(() => useStoreWithRenderCount(arrayStore, (state) => state.items.length));
    const itemKeys = renderHook(() =>
      useStoreWithRenderCount(arrayStore, (state) => Object.keys(state.items)),
    );

    act(() => {
      Object.defineProperty(arrayStore.state.items, "3", {
        configurable: true,
        enumerable: true,
        value: 4,
        writable: true,
      });
    });

    expect(index.result.current.state).toEqual(4);
    expect(index.result.current.count).toEqual(2);
    expect(length.result.current.state).toEqual(4);
    expect(length.result.current.count).toEqual(2);
    expect(itemKeys.result.current.state).toEqual(["0", "3"]);
    expect(itemKeys.result.current.count).toEqual(2);

    act(() => {
      Object.defineProperty(arrayStore.state.items, "length", { value: 1 });
    });

    expect(index.result.current.state).toBeUndefined();
    expect(index.result.current.count).toEqual(3);
    expect(length.result.current.state).toEqual(1);
    expect(length.result.current.count).toEqual(3);
    expect(itemKeys.result.current.state).toEqual(["0"]);
    expect(itemKeys.result.current.count).toEqual(3);
  });
});

describe("array length truncation notifications", () => {
  it("rerenders consumer watching specific index when that index is removed via length truncation", () => {
    const store = createStore({ arr: [10, 20, 30, 40, 50] });

    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr[3]));

    expect(result.current.state).toEqual(40);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.arr.length = 2;
    });

    expect(result.current.state).toEqual(undefined);
    expect(result.current.count).toEqual(2);
  });

  it("does not rerender a consumer watching an index retained by truncation", () => {
    const store = createStore({ arr: [10, 20, 30, 40, 50] });

    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr[1]));

    expect(result.current.state).toEqual(20);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.arr.length = 3;
    });

    expect(result.current.state).toEqual(20);
    expect(result.current.count).toEqual(1);
  });

  it("rerenders consumer watching array length when truncated", () => {
    const store = createStore({ arr: [1, 2, 3, 4, 5] });

    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr.length));

    expect(result.current.state).toEqual(5);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.arr.length = 2;
    });

    expect(result.current.state).toEqual(2);
    expect(result.current.count).toEqual(2);
  });

  it("does not incorrectly notify when array length is expanded", () => {
    const store = createStore({ arr: [1, 2, 3] });

    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr[5]));

    expect(result.current.state).toEqual(undefined);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.arr.length = 10;
    });

    expect(result.current.count).toEqual(1);
  });

  it("notifies direct index growth consumers once", () => {
    const store = createStore({ items: [1] });
    const indexCallback = mock();
    const lengthCallback = mock();
    const keysCallback = mock();
    const index = createConsumer(store, indexCallback);
    const length = createConsumer(store, lengthCallback);
    const keys = createConsumer(store, keysCallback);
    const listener = mock();
    const unsubscribe = subscribe(store, listener);
    void index.proxy.items[3];
    void length.proxy.items.length;
    Object.keys(keys.proxy.items);

    store.state.items[3] = 4;

    expect(indexCallback).toHaveBeenCalledTimes(1);
    expect(lengthCallback).toHaveBeenCalledTimes(1);
    expect(keysCallback).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    index.destroy();
    length.destroy();
    keys.destroy();
    unsubscribe();
  });

  it("notifies shifted index readers for a precise splice", () => {
    const store = createStore({ items: [1, 2, 3] });
    const callback = mock();
    const consumer = createConsumer(store, callback);
    void consumer.proxy.items[1];

    store.state.items.splice(0, 1);

    expect(store.state.items).toEqual([2, 3]);
    expect(callback).toHaveBeenCalledTimes(1);
    consumer.destroy();
  });
});

describe("'in' operator dependency tracking", () => {
  it("rerenders when using 'in' operator and property is added", () => {
    const store = createStore<{ data: Record<string, number> }>({ data: { a: 1 } });

    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => "b" in state.data));

    expect(result.current.state).toEqual(false);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.data.b = 2;
    });

    expect(result.current.state).toEqual(true);
    expect(result.current.count).toEqual(2);
  });

  it("does not rerender when unrelated property changes", () => {
    const store = createStore<{ data: Record<string, number> }>({ data: { a: 1, b: 2 } });

    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => "a" in state.data));

    expect(result.current.state).toEqual(true);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.data.b = 999;
    });

    expect(result.current.count).toEqual(1);
  });
});

describe("createUseStore", () => {
  it("rerenders when selected state changes", () => {
    const store = createStore({ count: 0, name: "test" });
    const useTestStore = createUseStore(store);

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useTestStore((s) => s.count);
    });

    expect(result.current).toEqual(0);
    expect(renderCount).toEqual(1);

    act(() => {
      store.state.count = 5;
    });

    expect(result.current).toEqual(5);
    expect(renderCount).toEqual(2);
  });

  it("does not rerender when unrelated state changes", () => {
    const store = createStore({ count: 0, name: "test" });
    const useTestStore = createUseStore(store);

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useTestStore((s) => s.count);
    });

    expect(renderCount).toEqual(1);

    act(() => {
      store.state.name = "changed";
    });

    expect(renderCount).toEqual(1);
    expect(result.current).toEqual(0);
  });
});

describe("persist option", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips state and preserves unpersisted initial keys", async () => {
    const store = createStore({ count: 0 }, { persist: "test-store" });

    store.state.count = 5;
    await disposePersistence(store);

    expect(JSON.parse(readPersistedValue("test-store"))).toEqual(persistenceEnvelope({ count: 5 }));
    const reloaded = createStore({ count: 0, name: "default" }, { persist: "test-store" });
    expect(reloaded.state).toEqual({ count: 5, name: "default" });
  });

  it("does not persist functions", async () => {
    const store = createStore(
      {
        count: 0,
        increment() {
          this.count++;
        },
      },
      { persist: "test-store-7" },
    );

    store.state.increment();
    await disposePersistence(store);

    expect(JSON.parse(readPersistedValue("test-store-7"))).toEqual(persistenceEnvelope({ count: 1 }));
  });
});

describe("writes through consumer proxies", () => {
  it("terminates and notifies when writing to a nested object through the consumer proxy", () => {
    const store = createSimpleStore();

    const callback = mock();
    const consumer = createConsumer(store, callback);

    expect(consumer.proxy.nested.a).toEqual(3);
    expect(callback).toHaveBeenCalledTimes(0);

    consumer.proxy.nested.a = 42;

    expect(store.state.nested.a).toEqual(42);
    expect(callback).toHaveBeenCalledTimes(1);

    consumer.destroy();
  });

  it("terminates and re-renders when writing through the state returned by useStore", () => {
    const store = createSimpleStore();

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      const state = useStore(store);
      return { state, a: state.nested.a };
    });
    expect(renderCount).toEqual(1);
    expect(result.current.a).toEqual(3);

    act(() => {
      result.current.state.nested.a = 42;
    });

    expect(store.state.nested.a).toEqual(42);
    expect(result.current.a).toEqual(42);
    expect(renderCount).toEqual(2);

    act(() => {
      result.current.state.nested.a = 42;
    });
    expect(renderCount).toEqual(2);
  });
});

describe("selector identity changes", () => {
  it("recomputes when a selector closing over props changes, without a store mutation", () => {
    const items: Record<string, string> = { a: "alpha", b: "beta" };
    const store = createStore({ items });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useStore(store, (state) => state.items[id]),
      { initialProps: { id: "a" } },
    );

    expect(result.current).toEqual("alpha");

    rerender({ id: "b" });
    expect(result.current).toEqual("beta");
  });

  it("does not re-execute a stable selector on unrelated re-renders", () => {
    const store = createStore({ value: 42 });
    const selector = mock((state: { value: number }) => state.value);

    const { result, rerender } = renderHook(() => useStore(store, selector));
    expect(result.current).toEqual(42);
    const callsAfterMount = selector.mock.calls.length;

    rerender();
    rerender();

    expect(result.current).toEqual(42);
    expect(selector.mock.calls.length).toEqual(callsAfterMount);
  });

  it("keeps the previous snapshot reference when a new selector computes an equal value", () => {
    const store = createStore({ nested: { a: 1 }, other: 0 });

    let renderCount = 0;
    const { result, rerender } = renderHook(() => {
      renderCount++;
      return useStore(store, (state) => state.nested);
    });

    const first = result.current;
    expect(first.a).toEqual(1);
    const rendersAfterMount = renderCount;

    rerender();
    expect(result.current).toBe(first);
    expect(renderCount).toEqual(rendersAfterMount + 1);

    act(() => {
      store.state.other = 1;
    });
    expect(result.current).toBe(first);
    expect(renderCount).toEqual(rendersAfterMount + 1);
  });

  it("tracks sparse structure and nested values through array iteration", () => {
    const data: { label: string }[] = [];
    data.length = 2;
    data[1] = { label: "b" };
    const store = createStore({ data });
    const item = store.state.data[1];
    if (item === undefined) throw new Error("data item is missing");
    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (state) => state.data.map((entry) => entry.label).join(",")),
    );

    expect(result.current.state).toEqual(",b");
    expect(result.current.count).toEqual(1);

    act(() => {
      item.label = "B";
    });
    expect(result.current.state).toEqual(",B");
    expect(result.current.count).toEqual(2);

    act(() => {
      store.state.data.push({ label: "c" });
    });
    expect(result.current.state).toEqual(",B,c");
    expect(result.current.count).toEqual(3);
  });

  it("notifies array iteration when a computed index changes", () => {
    type ComputedIndexState = { source: number; values: number[] };
    const store = createStore((root: ComputedIndexState) => {
      const values = [0];
      Object.defineProperty(values, "0", {
        configurable: true,
        enumerable: true,
        get: () => root.source,
      });
      return { source: 1, values };
    });
    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (state) => state.values.map((value) => value).join(",")),
    );

    expect(result.current.state).toEqual("1");
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.source = 2;
    });

    expect(result.current.state).toEqual("2");
    expect(result.current.count).toEqual(2);
  });
});

describe("consumer view attribution", () => {
  it("attributes captured consumer reads to the active selector", () => {
    const store = createStore({ data: [{ id: 1, label: "a" }] });
    const outer = renderHook(() => useStoreWithRenderCount(store, (state) => state.data));
    const item = outer.result.current.state[0];
    const sourceItem = store.state.data[0];
    if (item === undefined || sourceItem === undefined) throw new Error("first data item is missing");

    const inner = renderHook(() => useStoreWithRenderCount(store, () => item.label));
    expect(inner.result.current.state).toEqual("a");

    act(() => {
      sourceItem.label = "A";
    });

    expect(inner.result.current.state).toEqual("A");
    expect(inner.result.current.count).toEqual(2);
    expect(outer.result.current.count).toEqual(1);
  });
});

describe("persistence failures", () => {
  it("does not throw, completes hydration, and disables persistence when localStorage is unavailable", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const onHydrated = mock();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage is not available");
      },
    });

    try {
      const store = createStore({ a: 1 }, { persist: { key: "guard-missing", onHydrated } });
      expect(store.state.a).toEqual(1);
      expect(hasHydrated(store)).toBe(true);
      await persistReady(store);
      await rehydrate(store);
      expect(onHydrated).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes("disabled"))).toBe(true);

      const { result } = renderHook(() => useFullStoreWithRenderCount(store));
      expect(result.current.state.a).toEqual(1);
      act(() => {
        store.state.a = 2;
      });
      expect(result.current.state.a).toEqual(2);
      expect(result.current.count).toEqual(2);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
      warnSpy.mockRestore();
    }
  });

  it("skips persisted getter values and recomputes them", () => {
    const key = "guard-getter";
    try {
      localStorage.setItem(key, serializedPersistenceEnvelope({ n: 3, double: 6 }));

      const store = createStore(
        {
          n: 2,
          get double() {
            return this.n * 2;
          },
        },
        { persist: key },
      );

      expect(store.state.n).toEqual(3);
      expect(store.state.double).toEqual(6);
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("keeps the store working and warns once per store when setItem throws", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const setItemCalls: unknown[] = [];
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: (...args: unknown[]) => {
          setItemCalls.push(args);
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {},
      },
    });

    try {
      const store = createStore({ a: 1 }, { persist: "guard-quota" });
      const { result } = renderHook(() => useStoreWithRenderCount(store, (s) => s.a));
      expect(result.current.state).toEqual(1);

      act(() => {
        store.state.a = 2;
      });
      await Promise.resolve();
      act(() => {
        store.state.a = 3;
      });
      await Promise.resolve();

      expect(result.current.state).toEqual(3);
      expect(result.current.count).toEqual(3);

      expect(setItemCalls.length).toEqual(2);
      const persistWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes("failed to persist"));
      expect(persistWarns.length).toEqual(1);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
      warnSpy.mockRestore();
    }
  });
});

describe("consumer lifecycle", () => {
  it("does not re-render a consumer when a delete fails", () => {
    const state: { visible: number; locked?: number } = { visible: 1 };
    Object.defineProperty(state, "locked", {
      value: 1,
      writable: true,
      configurable: false,
      enumerable: true,
    });
    const store = createStore(state);

    const { result } = renderHook(() => useFullStoreWithRenderCount(store));
    expect(result.current.state.locked).toEqual(1);
    expect(result.current.count).toEqual(1);

    act(() => {
      expect(Reflect.deleteProperty(store.state, "locked")).toBe(false);
    });
    expect(result.current.count).toEqual(1);
  });

  it("re-renders after consumer destroy and resubscribe (Activity hide/show)", async () => {
    const store = createStore({ n: 1 });

    const Reader = () => {
      const s = useStore(store);
      return createElement("div", { "data-testid": "activity-n" }, String(s.n));
    };
    const app = (mode: "hidden" | "visible") => {
      const activityProps = { mode, children: createElement(Reader) };
      return createElement(Activity, activityProps);
    };

    const { rerender } = render(app("visible"));
    expect(screen.getByTestId("activity-n").textContent).toBe("1");

    rerender(app("hidden"));
    await act(async () => {});

    rerender(app("visible"));
    expect(screen.getByTestId("activity-n").textContent).toBe("1");

    act(() => {
      store.state.n = 2;
    });
    expect(screen.getByTestId("activity-n").textContent).toBe("2");
  });

  it("does not notify consumers for no-op compound array methods", () => {
    const store = createStore<{ arr: number[] }>({ arr: [] });
    const onRerender = mock();
    const consumer = createConsumer(store, onRerender);

    expect(consumer.proxy.arr.length).toEqual(0);

    store.state.arr.pop();
    store.state.arr.shift();
    store.state.arr.push();
    store.state.arr.unshift();
    expect(onRerender).toHaveBeenCalledTimes(0);

    store.state.arr.push(1);
    expect(onRerender).toHaveBeenCalledTimes(1);

    store.state.arr.pop();
    expect(onRerender).toHaveBeenCalledTimes(2);

    consumer.destroy();
  });
});

describe("subscribe", () => {
  it("delivers each duplicate registration once per mutation and batch", () => {
    const store = createStore<{ a: number; b: number; c: number; d?: number }>({ a: 1, b: 2, c: 3 });
    const cb = mock();
    const unsubscribeFirst = subscribe(store, cb);
    const unsubscribeSecond = subscribe(store, cb);

    store.state.a = 10;
    expect(cb).toHaveBeenCalledTimes(2);

    batch(store, () => {
      store.state.a = 20;
      store.state.b = 21;
      store.state.c = 22;
    });
    expect(cb).toHaveBeenCalledTimes(4);

    store.state.d = 23;
    expect(cb).toHaveBeenCalledTimes(6);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("selector form tracks captured proxies and delivers (value, prevValue)", () => {
    const store = createStore({ user: { name: "x" }, unrelated: 0 });
    const capturedUser = store.state.user;
    const cb = mock();
    subscribe(store, () => capturedUser.name, cb);

    store.state.unrelated = 1;
    expect(cb).toHaveBeenCalledTimes(0);

    capturedUser.name = "y";
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("y", "x");
  });

  it("equalityFn suppresses equal-but-new-reference selections", () => {
    const store = createStore({ a: 1, b: 2 });
    const cb = mock();
    subscribe(store, (s) => ({ sum: s.a + s.b }), cb, {
      equalityFn: (x, y) => x.sum === y.sum,
    });

    store.state.a = 2;
    expect(cb).toHaveBeenCalledTimes(1);

    batch(store, () => {
      store.state.a = 1;
      store.state.b = 3;
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("re-tracks conditional selector branches", () => {
    const store = createStore({ useB: false, a: 1, b: 10 });
    const cb = mock();
    subscribe(store, (s) => (s.useB ? s.b : s.a), cb);

    store.state.useB = true;
    expect(cb).toHaveBeenCalledTimes(1);

    store.state.a = 5;
    expect(cb).toHaveBeenCalledTimes(1);

    store.state.b = 11;
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops delivery and is idempotent for both forms", () => {
    const store = createStore({ n: 0 });
    const plain = mock();
    const selected = mock();
    const unsubPlain = subscribe(store, plain);
    const unsubSelected = subscribe(store, (s) => s.n, selected);

    store.state.n = 1;
    expect(plain).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledTimes(1);

    unsubPlain();
    unsubPlain();
    unsubSelected();
    unsubSelected();

    store.state.n = 2;
    expect(plain).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledTimes(1);
  });

  it("fireImmediately invokes synchronously at subscribe time", () => {
    const store = createStore({ n: 7 });
    const plain = mock();
    const selected = mock();
    subscribe(store, plain, { fireImmediately: true });
    subscribe(store, (s) => s.n, selected, { fireImmediately: true });

    expect(plain).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith(7, 7);
  });

  it("a throwing listener does not starve later listeners", () => {
    const store = createStore({ n: 0 });
    const captured: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (task: () => void) => {
      try {
        task();
      } catch (error) {
        captured.push(error);
      }
    };

    try {
      subscribe(store, () => {
        throw new Error("boom");
      });
      const second = mock();
      subscribe(store, second);

      store.state.n = 1;

      expect(second).toHaveBeenCalledTimes(1);
      expect(captured.length).toEqual(1);
      expect(String(captured[0])).toContain("boom");
    } finally {
      globalThis.queueMicrotask = original;
    }
  });

  it("a subscription created inside a batch fires at batch end", () => {
    const store = createStore({ n: 0 });
    const cb = mock();

    batch(store, () => {
      store.state.n = 1;
      subscribe(store, cb);
      store.state.n = 2;
      expect(cb).toHaveBeenCalledTimes(0);
    });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("a throwing selector does not break delivery to other subscribers", () => {
    const store = createStore({ n: 0 });
    const captured: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (task: () => void) => {
      try {
        task();
      } catch (error) {
        captured.push(error);
      }
    };

    try {
      let selectorRuns = 0;
      subscribe(
        store,
        (s) => {
          selectorRuns++;
          if (selectorRuns > 1) throw new Error("selector boom");
          return s.n;
        },
        mock(),
      );
      const second = mock();
      subscribe(store, second);

      store.state.n = 1;

      expect(second).toHaveBeenCalledTimes(1);
      expect(captured.length).toEqual(1);
      expect(String(captured[0])).toContain("selector boom");
    } finally {
      globalThis.queueMicrotask = original;
    }
  });
});

describe("snapshot", () => {
  it("is referentially stable until the next effective mutation", () => {
    const store = createStore({ count: 1, nested: { a: 2 } });

    const snap = snapshot(store);
    expect(snapshot(store)).toBe(snap);

    store.state.count = 1;
    expect(snapshot(store)).toBe(snap);

    store.state.count = 2;
    const next = snapshot(store);
    expect(next).not.toBe(snap);
    expect(next.count).toEqual(2);
    expect(snap.count).toEqual(1);
  });

  it("contains zero proxies anywhere in the tree", () => {
    const store = createStore({ a: { b: { c: [{ d: 1 }] } } });
    void store.state.a.b.c[0];

    const scan = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      expect(unwrapProxy(node, true)).toBe(node);
      for (const child of Object.values(node)) {
        scan(child);
      }
    };
    scan(snapshot(store));
  });

  it("removes actions and materializes getters as data properties", () => {
    const store = createStore({
      n: 2,
      get double() {
        return this.n * 2;
      },
      inc() {
        this.n++;
      },
    });

    const snap = snapshot(store);
    expect(snap.double).toEqual(4);
    expect(Object.getOwnPropertyDescriptor(snap, "double")?.get).toBeUndefined();
    expect("inc" in snap).toBe(false);
  });

  it("is deep-frozen in development builds", () => {
    const store = createStore({ nested: { a: 1 } });
    const snap = snapshot(store);

    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.nested)).toBe(true);
    expect(() => Object.defineProperty(snap.nested, "a", { value: 5 })).toThrow();
  });

  it("terminates on getter cycles and reuses the built node", () => {
    const store = createStore((root: { n: number; readonly self: unknown }) => ({
      n: 1,
      get self(): unknown {
        return root;
      },
    }));

    const snap = snapshot(store);
    expect(snap.self).toBe(snap);
    expect(snap.n).toEqual(1);
  });

  it("includes built-ins by reference", () => {
    const createdAt = new Date();
    const tags = new Set(["a"]);
    const store = createStore({ createdAt, tags });

    const snap = snapshot(store);
    expect(snap.createdAt).toBe(createdAt);
    expect(snap.tags).toBe(tags);
  });

  it("includes symbol and non-enumerable state while omitting symbol actions", () => {
    const token = Symbol("token");
    const action = Symbol("action");
    const source: { [token]: { value: number }; hidden?: number; [action]?: () => void } = {
      [token]: { value: 1 },
    };
    Object.defineProperty(source, "hidden", {
      value: 2,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    Object.defineProperty(source, action, {
      value: () => {},
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const store = createStore(source);

    const snap = snapshot(store);

    expect(snap[token].value).toBe(1);
    expect(snap.hidden).toBe(2);
    expect(Object.getOwnPropertyDescriptor(snap, "hidden")?.enumerable).toBe(false);
    expect(Object.hasOwn(snap, action)).toBe(false);
  });

  it("preserves sparse arrays and augmented own properties", () => {
    const tag = Symbol("tag");
    const values: string[] & { note?: string; [tag]?: number } = [];
    values.length = 3;
    values[1] = "x";
    Object.defineProperty(values, "note", {
      value: "hidden",
      configurable: true,
      enumerable: false,
      writable: true,
    });
    values[tag] = 7;
    const store = createStore({ values });

    const snap = snapshot(store).values;

    expect(snap).toHaveLength(3);
    expect(Object.hasOwn(snap, 0)).toBe(false);
    expect(Object.hasOwn(snap, 1)).toBe(true);
    expect(Object.hasOwn(snap, 2)).toBe(false);
    expect(Reflect.get(snap, "note")).toBe("hidden");
    expect(Object.getOwnPropertyDescriptor(snap, "note")?.enumerable).toBe(false);
    expect(Reflect.get(snap, tag)).toBe(7);
  });
});

describe("persistence format", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("ignores malformed envelopes and non-record payloads, then repairs on the next write", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const foreignPayloads = [
      JSON.stringify(42),
      JSON.stringify(null),
      JSON.stringify([PERSIST_FORMAT, 2, 0, { n: 42 }]),
      JSON.stringify([PERSIST_FORMAT, "0", { n: 42 }]),
      JSON.stringify(["something", 0, { n: 42 }]),
      JSON.stringify([PERSIST_FORMAT, 0]),
    ];
    try {
      for (const [index, payload] of foreignPayloads.entries()) {
        const key = `persist-corrupt-${index}`;
        localStorage.setItem(key, payload);
        const store = createStore({ n: 0 }, { persist: { key } });
        expect(store.state.n).toEqual(0);
        localStorage.removeItem(key);
      }
      const corruptWarns = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes("ignoring corrupt persisted state"),
      );
      expect(corruptWarns.length).toEqual(foreignPayloads.length);

      const key = "persist-corrupt-repair";
      const writes: string[] = [];
      let notifyWrite: (() => void) | null = null;
      localStorage.setItem(key, JSON.stringify([PERSIST_FORMAT, 0]));
      const store = createStore(
        { n: 0 },
        {
          persist: {
            key,
            storage: {
              getItem: () => localStorage.getItem(key),
              setItem: (_key: string, value: string) => {
                writes.push(value);
                notifyWrite?.();
                notifyWrite = null;
              },
              removeItem: () => {},
            },
          },
        },
      );
      const wrote = new Promise<void>((resolve) => {
        notifyWrite = resolve;
      });
      store.state.n = 7;
      await wrote;
      const lastWrite = writes.at(-1);
      if (lastWrite === undefined) throw new Error("the repair write never happened");
      expect(JSON.parse(lastWrite)).toEqual(persistenceEnvelope({ n: 7 }));
      localStorage.removeItem(key);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects an array payload in a valid persistence envelope without importing array keys", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const store = createStore(
      { n: 1 },
      {
        persist: {
          key: "persist-array-payload",
          storage: {
            getItem: () => serializedPersistenceEnvelope([7, 8]),
            setItem: () => {},
            removeItem: () => {},
          },
        },
      },
    );
    try {
      expect(store.state.n).toBe(1);
      expect(Object.hasOwn(store.state, "0")).toBe(false);
      expect(Object.hasOwn(store.state, "1")).toBe(false);
      expect(Object.hasOwn(store.state, "length")).toBe(false);
      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes("ignoring corrupt persisted state")),
      ).toBe(true);
      await disposePersistence(store);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("round-trips NaN, Infinity, and negative-zero keys and values", async () => {
    const key = "persist-number-tags";
    try {
      const store = createStore(
        {
          special: proxyMap<number, string>(),
          readings: [0, 0, 0, 0],
        },
        { persist: key },
      );
      store.state.special.set(Number.NaN, "nan");
      store.state.special.set(Infinity, "up");
      store.state.special.set(-Infinity, "down");
      store.state.special.set(-0, "zero");
      store.state.readings = [Number.NaN, Infinity, -Infinity, -0];
      expect(await disposePersistence(store)).toEqual({ flushed: true });

      const reloaded = createStore(
        { special: proxyMap<number, string>(), readings: [0, 0, 0, 0] },
        { persist: key },
      );
      expect(reloaded.state.special.get(Number.NaN)).toEqual("nan");
      expect(reloaded.state.special.get(Infinity)).toEqual("up");
      expect(reloaded.state.special.get(-Infinity)).toEqual("down");
      expect(reloaded.state.special.get(0)).toEqual("zero");
      expect(reloaded.state.special.get(-0)).toEqual("zero");
      const zeroKey = [...reloaded.state.special.keys()].find((mapKey) => mapKey === 0);
      expect(Object.is(zeroKey, 0)).toBe(true);
      expect(Object.is(zeroKey, -0)).toBe(false);
      expect(Number.isNaN(reloaded.state.readings[0])).toBe(true);
      expect(reloaded.state.readings[1]).toBe(Infinity);
      expect(reloaded.state.readings[2]).toBe(-Infinity);
      expect(Object.is(reloaded.state.readings[3], -0)).toBe(true);
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("escapes tag-shaped objects", async () => {
    const key = "persist-escape";
    type NumberTagShaped = { "$statelift.number": number };
    type EscapeTagShaped = { "$statelift.escape": number };
    type TagShapedState = { weird: NumberTagShaped; nested: { inner: EscapeTagShaped } };
    try {
      const initial: TagShapedState = {
        weird: { "$statelift.number": 0 },
        nested: { inner: { "$statelift.escape": 1 } },
      };
      const store = createStore(initial, { persist: key });
      store.state.weird = { "$statelift.number": Number.NaN };
      expect(await disposePersistence(store)).toEqual({ flushed: true });

      const reloadedInitial: TagShapedState = {
        weird: { "$statelift.number": 0 },
        nested: { inner: { "$statelift.escape": 0 } },
      };
      const reloaded = createStore(reloadedInitial, { persist: key });
      expect(Object.keys(reloaded.state.weird)).toEqual(["$statelift.number"]);
      expect(Number.isNaN(reloaded.state.weird["$statelift.number"])).toBe(true);
      expect(reloaded.state.nested.inner).toEqual({ "$statelift.escape": 1 });
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("treats a malformed escape wrapper as corrupt", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const malformedWrappers = [
      { value: { "$statelift.escape": { a: 1, b: 2 } } },
      { value: { "$statelift.escape": [1] } },
    ];
    try {
      for (const [index, payload] of malformedWrappers.entries()) {
        const key = `persist-bad-escape-${index}`;
        localStorage.setItem(key, JSON.stringify(persistenceEnvelope(payload)));
        const store = createStore({ value: { safe: true } }, { persist: key });
        expect(store.state.value).toEqual({ safe: true });
        localStorage.removeItem(key);
      }
      const corruptWarns = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes("ignoring corrupt persisted state"),
      );
      expect(corruptWarns.length).toEqual(malformedWrappers.length);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("treats an unknown number tag as corrupt", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const key = "persist-unknown-tag";
    try {
      localStorage.setItem(
        key,
        JSON.stringify(persistenceEnvelope({ value: { "$statelift.number": "sideways" } })),
      );
      const store = createStore({ value: 1 }, { persist: key });
      expect(store.state.value).toEqual(1);
      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes("ignoring corrupt persisted state")),
      ).toBe(true);
    } finally {
      localStorage.removeItem(key);
      warnSpy.mockRestore();
    }
  });

  it("disposePersistence resolves flushed=true after successful writes and for persist-less stores", async () => {
    expect(await disposePersistence(createStore({ n: 1 }))).toEqual({ flushed: true });

    const key = "dispose-flushed";
    try {
      const store = createStore({ n: 0 }, { persist: key });
      store.state.n = 1;
      const result = await disposePersistence(store);
      expect(result).toEqual({ flushed: true });
      expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(persistenceEnvelope({ n: 1 }));
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("disposePersistence resolves flushed=false after storage and serialization failures", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rejecting = createStore(
        { n: 0 },
        {
          persist: {
            key: "dispose-unflushed-storage",
            storage: {
              getItem: () => null,
              setItem: () => Promise.reject(new Error("write failed")),
              removeItem: () => {},
            },
          },
        },
      );
      rejecting.state.n = 1;
      const stored = await disposePersistence(rejecting);
      expect(stored).toEqual({ flushed: false });
      expect(await disposePersistence(rejecting)).toEqual({ flushed: false });

      const unserializable = createStore(
        { n: 0, big: BigInt(1) },
        {
          persist: {
            key: "dispose-unflushed-serialize",
            storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
          },
        },
      );
      unserializable.state.n = 1;
      expect(await disposePersistence(unserializable)).toEqual({ flushed: false });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("invokes migrate with (savedState, savedVersion) and merges its result", () => {
    localStorage.setItem("persist-migrate", serializedPersistenceEnvelope({ products: [1, 2] }, 1));
    const migrate = mock((saved: unknown, _savedVersion: number) => {
      if (saved === null || typeof saved !== "object") throw new TypeError("saved state is not a record");
      const products: unknown = Reflect.get(saved, "products");
      if (!Array.isArray(products) || !products.every((value) => typeof value === "number")) {
        throw new TypeError("saved products are invalid");
      }
      return { items: products };
    });

    const store = createStore<{ items: number[] }>(
      { items: [] },
      { persist: { key: "persist-migrate", version: 2, migrate } },
    );

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith({ products: [1, 2] }, 1);
    expect(store.state.items).toEqual([1, 2]);
  });

  it("discards and warns on version mismatch without migrate", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      localStorage.setItem("persist-nomigrate", serializedPersistenceEnvelope({ n: 99 }, 1));

      const store = createStore({ n: 0 }, { persist: { key: "persist-nomigrate", version: 2 } });

      expect(store.state.n).toEqual(0);
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes("discarding persisted state"))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("discards and warns when migrate throws", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      localStorage.setItem("persist-badmigrate", serializedPersistenceEnvelope({ n: 99 }, 1));

      const store = createStore(
        { n: 0 },
        {
          persist: {
            key: "persist-badmigrate",
            version: 2,
            migrate: () => {
              throw new Error("bad migration");
            },
          },
        },
      );

      expect(store.state.n).toEqual(0);
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes("migration"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("partialize persists only the subset and preserves unpersisted keys on reload", async () => {
    const options = {
      key: "persist-partial",
      partialize: (s: { readonly items: readonly number[]; readonly uiFlag: boolean }) => ({
        items: s.items,
      }),
    };
    const store = createStore({ items: [1], uiFlag: true }, { persist: options });

    store.state.items.push(2);
    store.state.uiFlag = false;
    await disposePersistence(store);

    expect(JSON.parse(readPersistedValue("persist-partial"))).toEqual(persistenceEnvelope({ items: [1, 2] }));

    const reloaded = createStore<{ items: number[]; uiFlag: boolean }>(
      { items: [], uiFlag: true },
      { persist: options },
    );
    expect(reloaded.state.items).toEqual([1, 2]);
    expect(reloaded.state.uiFlag).toEqual(true);
  });

  it("hydrates from an async adapter after sync init, with one re-render", async () => {
    let resolveGet: ((value: string | null) => void) | undefined;
    const adapter = {
      getItem: () =>
        new Promise<string | null>((resolve) => {
          resolveGet = resolve;
        }),
      setItem: () => {},
      removeItem: () => {},
    };

    const store = createStore({ n: 0 }, { persist: { key: "persist-async", storage: adapter } });

    expect(store.state.n).toEqual(0);
    expect(hasHydrated(store)).toBe(false);

    const { result } = renderHook(() => useStoreWithRenderCount(store, (s) => s.n));
    expect(result.current.count).toEqual(1);

    await act(async () => {
      if (resolveGet === undefined) throw new Error("persistence read did not start");
      resolveGet(serializedPersistenceEnvelope({ n: 7 }));
      await persistReady(store);
    });

    expect(store.state.n).toEqual(7);
    expect(result.current.state).toEqual(7);
    expect(result.current.count).toEqual(2);
    expect(hasHydrated(store)).toBe(true);
  });

  it("drops writes scheduled before async hydration completes", async () => {
    const writes: string[] = [];
    let resolveGet: ((value: string | null) => void) | undefined;
    const adapter = {
      getItem: () =>
        new Promise<string | null>((resolve) => {
          resolveGet = resolve;
        }),
      setItem: (_key: string, value: string) => {
        writes.push(value);
      },
      removeItem: () => {},
    };

    const store = createStore({ n: 0 }, { persist: { key: "persist-drop", storage: adapter } });

    store.state.n = 1;
    expect(writes.length).toEqual(0);

    if (resolveGet === undefined) throw new Error("persistence read did not start");
    resolveGet(null);
    await persistReady(store);
    expect(hasHydrated(store)).toBe(true);

    store.state.n = 2;
    await disposePersistence(store);
    expect(writes.length).toEqual(1);
    const firstWrite = writes[0];
    if (firstWrite === undefined) throw new Error("persistence write did not complete");
    expect(JSON.parse(firstWrite)).toEqual(persistenceEnvelope({ n: 2 }));
  });

  it("a rejecting async getItem warns and completes hydration", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = {
        getItem: () => Promise.reject(new Error("io failure")),
        setItem: () => {},
        removeItem: () => {},
      };

      const store = createStore({ n: 0 }, { persist: { key: "persist-reject", storage: adapter } });
      expect(hasHydrated(store)).toBe(false);

      await persistReady(store);

      expect(hasHydrated(store)).toBe(true);
      expect(store.state.n).toEqual(0);
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes("failed to read"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("snapshot structural sharing", () => {
  it("shares unchanged subtrees across snapshots", () => {
    const store = createStore({ left: { a: 1 }, right: { b: 2 }, list: [1, 2] });
    const snap1 = snapshot(store);

    store.state.left.a = 5;
    const snap2 = snapshot(store);

    expect(snap2).not.toBe(snap1);
    expect(snap2.left).not.toBe(snap1.left);
    expect(snap2.left.a).toEqual(5);
    expect(snap2.right).toBe(snap1.right);
    expect(snap2.list).toBe(snap1.list);
    expect(Object.isFrozen(snap2.left)).toBe(true);
  });

  it("does not reuse a subtree mutated through a retained raw reference", () => {
    const retained = { value: 1 };
    const store = createStore({ retained, unrelated: 0 });
    const previous = snapshot(store);

    retained.value = 2;
    store.state.unrelated = 1;
    const next = snapshot(store);

    expect(next.retained.value).toBe(2);
    expect(next.retained).not.toBe(previous.retained);
    expect(previous.retained.value).toBe(1);
  });

  it("rebuilds a cyclic child against the current snapshot root", () => {
    type CyclicState = { sibling: number; child: { value: number; parent: CyclicState } };
    const store = createStore((root: CyclicState) => ({
      sibling: 1,
      child: { value: 1, parent: root },
    }));
    const previous = snapshot(store);

    store.state.child.value = 2;
    const next = snapshot(store);

    expect(next.child.parent).toBe(next);
    expect(previous.child.parent).toBe(previous);
    expect(next.child.parent).not.toBe(previous);
  });
});

describe("computed stores", () => {
  it("derives from a single store and recomputes only on tracked changes", () => {
    let runs = 0;
    const store = createStore({ a: 1, b: 2, other: 0 });
    const totals = computed(store, (s) => {
      runs++;
      return s.a + s.b;
    });

    expect(totals.state.value).toEqual(3);
    expect(runs).toEqual(1);

    store.state.other = 9;
    expect(runs).toEqual(1);

    store.state.a = 10;
    expect(runs).toEqual(2);
    expect(totals.state.value).toEqual(12);
  });

  it("reflects a source change delivered before the output store exists", () => {
    const source = createStore({ n: 0 });
    const derived = computed(source, (s) => {
      if (s.n < 1) s.n = 1;
      return s.n;
    });

    expect(derived.state.value).toEqual(1);
    source.state.n = 5;
    expect(derived.state.value).toEqual(5);
  });

  it("derives across multiple stores with per-source tracking", () => {
    const x = createStore({ n: 1 });
    const y = createStore({ n: 2 });
    const sum = computed({ x, y }, ({ x: xs, y: ys }) => xs.n + ys.n);

    expect(sum.state.value).toEqual(3);

    x.state.n = 10;
    expect(sum.state.value).toEqual(12);

    y.state.n = 20;
    expect(sum.state.value).toEqual(30);
  });

  it("notifies downstream only when the derived value changes", () => {
    const store = createStore({ n: 5 });
    const clamped = computed(store, (s) => Math.min(s.n, 3));
    const received: number[] = [];
    subscribe(
      clamped,
      (c) => c.value,
      (value) => received.push(value),
    );

    store.state.n = 4;
    expect(received.length).toEqual(0);

    store.state.n = 1;
    expect(received).toEqual([1]);
  });

  it("keeps the previous value and rethrows async when the derivation throws", () => {
    const captured: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (task: () => void) => {
      try {
        task();
      } catch (error) {
        captured.push(error);
      }
    };

    try {
      const store = createStore({ n: 1 });
      const risky = computed(store, (s) => {
        if (s.n < 0) throw new Error("negative derive");
        return s.n;
      });

      store.state.n = -1;
      expect(captured.length).toEqual(1);
      expect(risky.state.value).toEqual(1);

      store.state.n = 5;
      expect(risky.state.value).toEqual(5);
    } finally {
      globalThis.queueMicrotask = original;
    }
  });
});

describe("coarse compound delivery", () => {
  it("delivers one notification to iteration consumers on storm splices", () => {
    const store = createStore({ list: Array.from({ length: 100 }, (_, i) => i) });
    const iterationReader = mock();
    const consumer = createConsumer(store, iterationReader);
    const { list: selectedList } = consumer.proxy;
    void [...selectedList];

    store.state.list.splice(0, 1);

    expect(iterationReader).toHaveBeenCalledTimes(1);
    const { list: updatedList } = consumer.proxy;
    expect(updatedList).not.toBe(selectedList);
    expect(store.state.list.length).toEqual(99);
    expect(store.state.list[0]).toEqual(1);

    consumer.destroy();
  });

  it("drains a two-level computed chain before a coarse iteration consumer", () => {
    const store = createStore(
      (root: { list: number[]; readonly base: number; readonly derived: number }) => ({
        list: Array.from({ length: 100 }, (_, index) => index),
        get base() {
          return root.list[0] ?? -1;
        },
        get derived() {
          return root.base * 2;
        },
      }),
    );
    const selector = (state: typeof store.state) => {
      Reflect.apply(state.list.forEach, state.list, [() => undefined]);
      return state.derived;
    };
    const deliveries: number[] = [];
    let readSelection = () => 0;
    const consumer = createConsumer(store, () => deliveries.push(readSelection()));
    readSelection = () => consumer.track(selector);
    expect(readSelection()).toBe(0);

    store.state.list.splice(0, 1);

    expect(deliveries).toEqual([2]);
    consumer.destroy();
  });

  it("uses coarse delivery for unshifted-index readers on storm splices", () => {
    const store = createStore({ list: Array.from({ length: 100 }, (_, i) => i) });
    const headReader = mock();
    const consumer = createConsumer(store, headReader);
    void consumer.proxy.list[0];

    store.state.list.splice(1, 1);

    expect(headReader).toHaveBeenCalledTimes(1);
    expect(store.state.list[0]).toEqual(0);

    consumer.destroy();
  });
});

describe("subscribe string paths", () => {
  it("subscribes to a dotted path with (value, prev) granularity", () => {
    const store = createStore({ user: { name: "a", age: 1 }, other: 0 });
    const calls: [string, string][] = [];
    const unsub = subscribe(store, "user.name", (name, prev) => calls.push([name, prev]));

    store.state.other = 5;
    expect(calls.length).toEqual(0);

    store.state.user.age = 2;
    expect(calls.length).toEqual(0);

    store.state.user.name = "b";
    expect(calls).toEqual([["b", "a"]]);

    unsub();
    store.state.user.name = "c";
    expect(calls.length).toEqual(1);
  });

  it("selects undefined through missing intermediates and fires when the path materializes", () => {
    const store = createStore<{ user: { name: string } | null }>({ user: null });
    const values: unknown[] = [];
    subscribe(store, "user.name", (value) => values.push(value));

    store.state.user = { name: "x" };
    expect(values).toEqual(["x"]);
  });

  it("supports equalityFn on the path form", () => {
    const store = createStore({ user: { name: "a" } });
    const calls: unknown[] = [];
    subscribe(store, "user", (value) => calls.push(value), { equalityFn: shallow });

    store.state.user = { name: "a" };
    expect(calls.length).toEqual(0);

    store.state.user = { name: "b" };
    expect(calls.length).toEqual(1);
  });
});

describe("restore", () => {
  it("round-trips a snapshot checkpoint with replace semantics", () => {
    type RestoreState = {
      n: number;
      nested: { v: number; readonly dbl: number };
      tags: ProxySet<string>;
      increment: () => void;
      added?: string;
    };
    const store = createStore<RestoreState>({
      n: 1,
      nested: {
        v: 1,
        get dbl() {
          return this.v * 2;
        },
      },
      tags: proxySet(["x"]),
      increment() {
        this.n++;
      },
    });
    const checkpoint = snapshot(store);

    store.state.n = 50;
    store.state.nested.v = 9;
    store.state.added = "extra";
    store.state.tags.add("y");

    restore(store, checkpoint);

    expect(store.state.n).toEqual(1);
    expect(store.state.nested.v).toEqual(1);
    expect(store.state.nested.dbl).toEqual(2);
    expect("added" in store.state).toBe(false);
    expect([...store.state.tags]).toEqual(["x"]);
    expect(typeof store.state.increment).toEqual("function");

    store.state.nested.v = 3;
    expect(store.state.nested.dbl).toEqual(6);
  });

  it("notifies consumers once per restore batch", () => {
    const store = createStore({ nested: { a: 1, b: 2 } });
    const checkpoint = snapshot(store);
    const onRerender = mock();
    const consumer = createConsumer(store, onRerender);
    void consumer.proxy.nested.a;
    void consumer.proxy.nested.b;

    store.state.nested.a = 10;
    store.state.nested.b = 20;
    const before = onRerender.mock.calls.length;

    restore(store, checkpoint);

    expect(onRerender.mock.calls.length).toEqual(before + 1);
    expect(store.state.nested.a).toEqual(1);
    expect(store.state.nested.b).toEqual(2);

    consumer.destroy();
  });

  it("preflights descriptor failures before applying earlier fields", () => {
    const source = { first: 1, locked: 1 };
    Object.defineProperty(source, "locked", {
      value: 1,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    const store = createStore(source);
    const listener = mock();
    const unsubscribe = subscribe(store, listener);

    expect(() => restore(store, { first: 2, locked: 2 })).toThrow(/non-writable property/);
    expect(store.state.first).toBe(1);
    expect(store.state.locked).toBe(1);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("restores setter-backed state", () => {
    let value = 1;
    const source = {
      get current() {
        return value;
      },
      set current(next: number) {
        value = next;
      },
    };
    const store = createStore(source);
    const checkpoint = snapshot(store);

    store.state.current = 9;
    restore(store, checkpoint);

    expect(store.state.current).toBe(1);
  });

  it("reattaches an object-valued proxySet member with its identity and code", () => {
    type Item = {
      value: number;
      self?: Item;
      increment: () => void;
      readonly double: number;
    };
    const item: Item = {
      value: 1,
      increment() {
        this.value++;
      },
      get double() {
        return this.value * 2;
      },
    };
    item.self = item;
    const store = createStore({ items: proxySet<Item>([item]), alias: item });
    const checkpoint = snapshot(store);
    const original = store.state.alias;

    original.value = 9;
    store.state.items.delete(original);
    store.state.alias = {
      value: 5,
      increment() {
        this.value++;
      },
      get double() {
        return this.value * 2;
      },
    };
    restore(store, checkpoint);

    const restored = [...store.state.items][0];
    if (restored === undefined) throw new Error("restored Set member is missing");
    expect(restored).toBe(original);
    expect(store.state.alias).toBe(original);
    expect(restored.self).toBe(original);
    expect(restored.value).toBe(1);
    expect(restored.double).toBe(2);
    restored.increment();
    expect(restored.value).toBe(2);
  });

  it("restores sparse arrays, symbols, and non-enumerable properties exactly", () => {
    const token = Symbol("token");
    const values: string[] & { hidden?: string; [token]?: number } = [];
    values.length = 3;
    values[1] = "checkpoint";
    Object.defineProperty(values, "hidden", {
      value: "saved",
      configurable: true,
      enumerable: false,
      writable: true,
    });
    values[token] = 1;
    const store = createStore({ values });
    const checkpoint = snapshot(store);

    store.state.values[0] = "filled";
    store.state.values[1] = "changed";
    store.state.values[2] = "filled";
    Object.defineProperty(store.state.values, "hidden", {
      value: "changed",
      configurable: true,
      enumerable: true,
      writable: true,
    });
    store.state.values[token] = 2;
    restore(store, checkpoint);

    expect(Object.hasOwn(store.state.values, 0)).toBe(false);
    expect(store.state.values[1]).toBe("checkpoint");
    expect(Object.hasOwn(store.state.values, 2)).toBe(false);
    expect(store.state.values.hidden).toBe("saved");
    expect(Object.getOwnPropertyDescriptor(store.state.values, "hidden")?.enumerable).toBe(false);
    expect(store.state.values[token]).toBe(1);
  });

  it("restores explicit undefined properties and array entries instead of leaving holes", () => {
    const initialState: { present: number | undefined; values: (number | undefined)[] } = {
      present: undefined,
      values: [undefined],
    };
    const store = createStore(initialState);
    const checkpoint = snapshot(store);

    Reflect.deleteProperty(store.state, "present");
    Reflect.deleteProperty(store.state.values, "0");
    restore(store, checkpoint);

    expect(Object.hasOwn(store.state, "present")).toBe(true);
    expect(store.state.present).toBeUndefined();
    expect(Object.hasOwn(store.state.values, 0)).toBe(true);
    expect(store.state.values[0]).toBeUndefined();
  });

  it("recreates a deleted reactive collection as a reactive container", () => {
    type CollectionState = { items?: ProxyMap<string, number> };
    const store = createStore<CollectionState>({ items: proxyMap([["a", 1]]) });
    const checkpoint = snapshot(store);
    Reflect.deleteProperty(store.state, "items");

    restore(store, checkpoint);

    const items = store.state.items;
    if (items === undefined) throw new Error("restored reactive collection is missing");
    expect(items instanceof Map).toBe(false);
    expect(items.get("a")).toBe(1);

    const onChange = mock();
    const unsubscribe = subscribe(store, (state) => state.items?.get("b"), onChange);
    items.set("b", 2);

    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("action labels", () => {
  it("reports explicit batch labels", () => {
    const store = createStore({ n: 0 });
    const labels: (string | null)[] = [];
    const unsubscribe = subscribe(store, () => {
      labels.push(getActionLabel(store));
    });

    store.state.n++;
    batch(
      store,
      () => {
        store.state.n++;
      },
      { label: "increment" },
    );

    expect(labels).toEqual([null, "increment"]);
    unsubscribe();
  });
});

describe("persistence options", () => {
  it("uses a custom serializer for writes and reads", async () => {
    const key = "persist-serializer";
    const serializer = {
      stringify: (value: unknown) => `S:${JSON.stringify(value)}`,
      parse: (raw: string): unknown => JSON.parse(raw.slice(2)),
    };
    try {
      const store = createStore({ n: 1 }, { persist: { key, serializer } });
      store.state.n = 5;
      await disposePersistence(store);
      expect(localStorage.getItem(key)).toEqual(`S:${serializedPersistenceEnvelope({ n: 5 })}`);

      const reloaded = createStore({ n: 0 }, { persist: { key, serializer } });
      expect(reloaded.state.n).toEqual(5);
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("skipHydration parks stored state and writes until rehydrate()", async () => {
    const key = "persist-skip";
    try {
      localStorage.setItem(key, serializedPersistenceEnvelope({ n: 7 }));
      const store = createStore({ n: 0 }, { persist: { key, skipHydration: true } });

      expect(store.state.n).toEqual(0);
      expect(hasHydrated(store)).toBe(false);

      store.state.n = 3;
      expect(JSON.parse(readPersistedValue(key))).toEqual(persistenceEnvelope({ n: 7 }));

      await rehydrate(store);
      expect(store.state.n).toEqual(7);
      expect(hasHydrated(store)).toBe(true);

      store.state.n = 9;
      await disposePersistence(store);
      expect(JSON.parse(readPersistedValue(key))).toEqual(persistenceEnvelope({ n: 9 }));
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("explicit sequencing: rehydrate then hydrate makes server data win", async () => {
    const key = "persist-skip-order";
    try {
      localStorage.setItem(key, serializedPersistenceEnvelope({ n: 7 }));
      const store = createStore({ n: 0 }, { persist: { key, skipHydration: true } });

      await rehydrate(store);
      expect(store.state.n).toEqual(7);

      hydrate(store, { n: 42 });
      expect(store.state.n).toEqual(42);

      localStorage.setItem(key, serializedPersistenceEnvelope({ n: 7 }));
      await rehydrate(store);
      expect(store.state.n).toEqual(7);
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("persistReady resolves when hydration finishes", async () => {
    let resolveGet: ((value: string | null) => void) | undefined;
    const adapter = {
      getItem: () =>
        new Promise<string | null>((resolve) => {
          resolveGet = resolve;
        }),
      setItem: () => {},
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "persist-ready", storage: adapter } });

    let settled = false;
    const ready = persistReady(store).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    if (resolveGet === undefined) throw new Error("persistence read did not start");
    resolveGet(serializedPersistenceEnvelope({ n: 5 }));
    await ready;
    expect(store.state.n).toEqual(5);

    await persistReady(createStore({ a: 1 }));

    const sync = createStore({ n: 0 }, { persist: "persist-ready-sync" });
    try {
      await persistReady(sync);
    } finally {
      localStorage.removeItem("persist-ready-sync");
    }
  });

  it("onHydrated fires exactly once", async () => {
    const onHydrated = mock();
    let first = true;
    let resolveGet: ((value: string | null) => void) | undefined;
    const adapter = {
      getItem: () => {
        if (first) {
          first = false;
          return new Promise<string | null>((resolve) => {
            resolveGet = resolve;
          });
        }
        return null;
      },
      setItem: () => {},
      removeItem: () => {},
    };
    const store = createStore(
      { n: 0 },
      { persist: { key: "persist-onhydrated", storage: adapter, onHydrated } },
    );

    expect(onHydrated).toHaveBeenCalledTimes(0);
    if (resolveGet === undefined) throw new Error("persistence read did not start");
    resolveGet(null);
    await persistReady(store);
    expect(onHydrated).toHaveBeenCalledTimes(1);

    await rehydrate(store);
    expect(onHydrated).toHaveBeenCalledTimes(1);
  });

  it("throttles writes to one per window with the latest state", async () => {
    jest.useFakeTimers();
    try {
      const writes: string[] = [];
      const adapter = {
        getItem: () => null,
        setItem: (_key: string, value: string) => {
          writes.push(value);
        },
        removeItem: () => {},
      };
      const store = createStore(
        { n: 0 },
        { persist: { key: "persist-throttle", storage: adapter, throttle: 20 } },
      );

      store.state.n = 1;
      store.state.n = 2;
      store.state.n = 3;
      jest.advanceTimersByTime(19);
      expect(writes).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(writes).toHaveLength(1);
      const firstWrite = writes[0];
      if (firstWrite === undefined) throw new Error("throttled persistence write did not complete");
      expect(JSON.parse(firstWrite)).toEqual(persistenceEnvelope({ n: 3 }));
      expect(await disposePersistence(store)).toEqual({ flushed: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it("syncAcrossTabs applies storage events from other tabs (opt-in only)", () => {
    const key = "persist-sync";
    const offKey = "persist-sync-off";
    try {
      const store = createStore({ n: 1 }, { persist: { key, syncAcrossTabs: true } });
      const off = createStore({ n: 1 }, { persist: { key: offKey } });

      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: serializedPersistenceEnvelope({ n: 99 }),
          storageArea: localStorage,
        }),
      );
      expect(store.state.n).toEqual(99);

      window.dispatchEvent(
        new StorageEvent("storage", {
          key: offKey,
          newValue: serializedPersistenceEnvelope({ n: 99 }),
          storageArea: localStorage,
        }),
      );
      expect(off.state.n).toEqual(1);
    } finally {
      localStorage.removeItem(key);
      localStorage.removeItem(offKey);
    }
  });

  it("dev-warns when two live stores persist to the same key and storage", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const key = "persist-collision";
    try {
      const first = createStore({ n: 1 }, { persist: key });
      void first;
      createStore({ n: 2 }, { persist: key });
      expect(
        warnSpy.mock.calls.some(([message]) =>
          String(message).includes("already used by another live store"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      localStorage.removeItem(key);
    }
  });
});

describe("computed caching", () => {
  it("recomputes exactly once per input change and serves reads from the cache", () => {
    let runs = 0;
    const store = createStore({
      n: 2,
      get double() {
        runs++;
        return this.n * 2;
      },
    });
    const onRerender = mock();
    const consumer = createConsumer(store, onRerender);
    expect(consumer.proxy.double).toEqual(4);
    runs = 0;

    store.state.n = 3;

    expect(runs).toEqual(1);
    expect(onRerender).toHaveBeenCalledTimes(1);
    expect(store.state.double).toEqual(6);
    expect(runs).toEqual(1);

    consumer.destroy();
  });

  it("does not notify readers when the recomputed value is equal", () => {
    const store = createStore({
      n: 5,
      get clamped() {
        return Math.min(this.n, 3);
      },
    });
    const onRerender = mock();
    const consumer = createConsumer(store, onRerender);
    expect(consumer.proxy.clamped).toEqual(3);

    store.state.n = 4;

    expect(onRerender).toHaveBeenCalledTimes(0);
    expect(store.state.clamped).toEqual(3);

    consumer.destroy();
  });

  it("chains computeds and recomputes each exactly once per input change", () => {
    let baseRuns = 0;
    let quadRuns = 0;
    const store = createStore((root: { n: number; readonly double: number; readonly quadruple: number }) => ({
      n: 1,
      get double() {
        baseRuns++;
        return root.n * 2;
      },
      get quadruple() {
        quadRuns++;
        return root.double * 2;
      },
    }));

    expect(store.state.quadruple).toEqual(4);
    expect(store.state.double).toEqual(2);
    expect(baseRuns).toEqual(1);
    expect(quadRuns).toEqual(1);

    baseRuns = 0;
    quadRuns = 0;
    store.state.n = 2;

    expect(store.state.quadruple).toEqual(8);
    expect(baseRuns).toEqual(1);
    expect(quadRuns).toEqual(1);
  });

  it("re-tracks conditional dependencies per recompute", () => {
    let runs = 0;
    const store = createStore({
      useB: false,
      a: 1,
      b: 10,
      get pick() {
        runs++;
        return this.useB ? this.b : this.a;
      },
    });
    expect(store.state.pick).toEqual(1);
    runs = 0;

    store.state.useB = true;
    expect(runs).toEqual(1);

    store.state.a = 5;
    expect(runs).toEqual(1);

    store.state.b = 11;
    expect(runs).toEqual(2);
    expect(store.state.pick).toEqual(11);
  });

  it("throws a descriptive error on computed cycles", () => {
    const store = createStore((root: { readonly a: unknown; readonly b: unknown }) => ({
      get a(): unknown {
        return root.b;
      },
      get b(): unknown {
        return root.a;
      },
    }));

    expect(() => store.state.a).toThrow(/cycle/);
  });

  it("uncached getters run on every read", () => {
    let runs = 0;
    const base: { n: number; readonly fresh?: number } = { n: 1 };
    Object.defineProperty(base, "fresh", {
      configurable: true,
      enumerable: true,
      get: uncached(() => {
        runs++;
        return base.n;
      }),
    });
    const store = createStore(base);

    expect(store.state.fresh).toEqual(1);
    expect(store.state.fresh).toEqual(1);
    expect(runs).toEqual(2);
  });

  it("evicts the cell when the computed is deleted and redefined as data", () => {
    let runs = 0;
    const store = createStore<{ n: number; double?: number }>({
      n: 2,
      get double() {
        runs++;
        return this.n * 2;
      },
    });

    expect(store.state.double).toEqual(4);
    expect(runs).toEqual(1);

    delete store.state.double;
    store.state.double = 99;

    expect(store.state.double).toEqual(99);
    store.state.n = 3;
    expect(store.state.double).toEqual(99);
    expect(runs).toEqual(1);
  });

  it("caches getters on nested objects assigned after creation", () => {
    let runs = 0;
    const store = createStore<{ mod: { v: number; readonly dbl: number } | null }>({ mod: null });

    store.state.mod = {
      v: 2,
      get dbl() {
        runs++;
        return this.v * 2;
      },
    };

    const moduleState = store.state.mod;
    if (moduleState === null) throw new Error("assigned module state is missing");
    expect(moduleState.dbl).toEqual(4);
    expect(moduleState.dbl).toEqual(4);
    expect(runs).toEqual(1);

    moduleState.v = 3;
    expect(runs).toEqual(2);
    expect(moduleState.dbl).toEqual(6);
    expect(runs).toEqual(2);
  });

  it("propagates getter errors to the reader and retries on the next read", () => {
    const captured: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (task: () => void) => {
      try {
        task();
      } catch (error) {
        captured.push(error);
      }
    };

    try {
      const store = createStore({
        n: 1,
        get risky() {
          if (this.n < 0) throw new Error("negative input");
          return this.n;
        },
      });

      expect(store.state.risky).toEqual(1);

      store.state.n = -1;
      expect(captured.length).toEqual(1);
      expect(String(captured[0])).toContain("negative input");

      expect(() => store.state.risky).toThrow("negative input");

      store.state.n = 2;
      expect(store.state.risky).toEqual(2);
    } finally {
      globalThis.queueMicrotask = original;
    }
  });

  it("evicts cells for detached subtrees (no recompute after detach)", async () => {
    let runs = 0;
    type Section = { v: number; readonly dbl: number };
    const section: Section = {
      v: 1,
      get dbl() {
        runs++;
        return this.v * 2;
      },
    };
    const store = createStore<{ section: Section | null }>({
      section,
    });
    const sectionProxy = store.state.section;
    if (sectionProxy === null) throw new Error("section state is missing");
    expect(sectionProxy.dbl).toEqual(2);
    expect(runs).toEqual(1);

    store.state.section = null;
    await Promise.resolve();

    sectionProxy.v = 5;
    expect(runs).toEqual(1);
  });

  it("keeps cells for symbol-keyed subtrees aliased across the reachability sweep", async () => {
    let runs = 0;
    type Section = { v: number; readonly dbl: number };
    const section = Symbol("section");
    const initialSection: Section = {
      v: 1,
      get dbl() {
        runs++;
        return this.v * 2;
      },
    };
    const store = createStore<{ [section]: Section | null; b: Section | null }>({
      [section]: initialSection,
      b: null,
    });

    const originalSection = store.state[section];
    if (originalSection === null) throw new Error("original section state is missing");
    expect(originalSection.dbl).toEqual(2);
    expect(runs).toEqual(1);

    store.state.b = originalSection;
    store.state[section] = null;
    await Promise.resolve();

    const aliasedSection = store.state.b;
    if (aliasedSection === null) throw new Error("aliased section state is missing");
    expect(aliasedSection.dbl).toEqual(2);
    expect(runs).toEqual(1);

    aliasedSection.v = 3;
    expect(runs).toEqual(2);
    expect(aliasedSection.dbl).toEqual(6);
  });

  it("keeps cells reachable through cached computed objects", async () => {
    let doubledRuns = 0;
    let unrelatedRuns = 0;
    const child = {
      input: 1,
      get doubled() {
        doubledRuns++;
        return this.input * 2;
      },
    };
    const store = createStore({
      detached: { value: 0 },
      get outer() {
        return { child };
      },
      get unrelated() {
        unrelatedRuns++;
        return this.detached.value;
      },
    });
    const callback = mock();
    const consumer = createConsumer(store, callback);
    const retainedChild = consumer.proxy.outer.child;

    expect(retainedChild.doubled).toEqual(2);
    expect(unrelatedRuns).toEqual(0);

    store.state.detached = { value: 1 };
    await Promise.resolve();
    retainedChild.input = 2;

    expect(callback).toHaveBeenCalledTimes(1);
    expect(retainedChild.doubled).toEqual(4);
    expect(doubledRuns).toEqual(2);
    expect(unrelatedRuns).toEqual(0);
    consumer.destroy();
  });

  it("keeps cells for proxied subtrees reinserted by aggregate replacement", async () => {
    let runs = 0;
    const style = {
      value: 1,
      get doubled() {
        runs++;
        return this.value * 2;
      },
    };
    const store = createStore({ item: { changed: false, style } });
    const styleProxy = store.state.item.style;

    expect(styleProxy.doubled).toBe(2);
    expect(styleProxy.doubled).toBe(2);
    expect(runs).toBe(1);

    const item = store.state.item;
    store.state.item = { ...item, changed: true };
    await Promise.resolve();

    expect(store.state.item.style).toBe(styleProxy);
    expect(store.state.item.style.doubled).toBe(2);
    expect(store.state.item.style.doubled).toBe(2);
    expect(runs).toBe(1);

    store.state.item.style.value = 2;
    expect(runs).toBe(2);
    expect(store.state.item.style.doubled).toBe(4);
    expect(runs).toBe(2);
  });
});

describe("shallow equality option", () => {
  const selectN = (s: { n: number }) => ({ n: s.n });

  it("suppresses re-renders and keeps the previous reference when the selection is shallow-equal", () => {
    const store = createStore({ list: [1, 2], other: 0 });
    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (s) => ({ count: s.list.length }), { equalityFn: shallow }),
    );
    expect(result.current.count).toEqual(1);
    const first = result.current.state;

    act(() => {
      store.state.list = [3, 4];
    });
    expect(result.current.count).toEqual(1);
    expect(result.current.state).toBe(first);

    act(() => {
      store.state.list = [1, 2, 3];
    });
    expect(result.current.count).toEqual(2);
    expect(result.current.state.count).toEqual(3);
    expect(result.current.state).not.toBe(first);
  });

  it("picks up the latest equalityFn identity between renders", () => {
    const store = createStore({ n: 1 });
    type EqFn = (a: { n: number }, b: { n: number }) => boolean;
    const alwaysEqual: EqFn = () => true;
    const initialProps: { eq: EqFn | undefined } = { eq: alwaysEqual };

    const { result, rerender } = renderHook(
      ({ eq }: { eq: EqFn | undefined }) =>
        useStoreWithRenderCount(store, selectN, eq ? { equalityFn: eq } : undefined),
      { initialProps },
    );
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.n = 2;
    });
    expect(result.current.count).toEqual(1);
    expect(result.current.state.n).toEqual(1);

    rerender({ eq: undefined });

    act(() => {
      store.state.n = 3;
    });
    expect(result.current.state.n).toEqual(3);
  });

  it("propagates a throwing equalityFn", () => {
    const store = createStore({ n: 1 });
    renderHook(() =>
      useStoreWithRenderCount(store, selectN, {
        equalityFn: () => {
          throw new Error("equality boom");
        },
      }),
    );

    expect(() => {
      act(() => {
        store.state.n = 2;
      });
    }).toThrow("equality boom");
  });

  it("createUseStore forwards the equality option", () => {
    const store = createStore({ list: [1, 2] });
    const useBound = createUseStore(store);
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useBound((s) => ({ count: s.list.length }), { equalityFn: shallow });
    });
    expect(result.current.count).toEqual(2);

    act(() => {
      store.state.list = [3, 4];
    });
    expect(renders).toEqual(1);
  });
});

describe("SSR and hydration", () => {
  it("server-renders through snapshot(), not the live proxy", () => {
    const store = createStore({ n: 5, nested: { v: 1 } });
    let received: unknown;

    const WithSelector = () => {
      const n = useStore(store, (s) => {
        received = s;
        return s.n;
      });
      return createElement("p", null, n);
    };
    const NoSelector = () => {
      const s = useStore(store);
      return createElement("p", null, s.nested.v);
    };

    expect(renderToString(createElement(WithSelector))).toContain("5");
    expect(renderToString(createElement(NoSelector))).toContain("1");

    if (received === null || typeof received !== "object") throw new Error("server snapshot is missing");
    expect(unwrapProxy(received, true)).toBe(received);
    expect(Object.isFrozen(received)).toBe(true);
  });

  it("preserves actions in selector and no-selector server views without hydration errors", async () => {
    type ActionState = {
      n: number;
      nested: { value: number };
      readonly callback: () => string;
      increment: () => void;
    };
    const store = createStore((root: ActionState) => ({
      n: 1,
      nested: { value: 2 },
      get callback() {
        return () => "computed function";
      },
      increment() {
        root.n++;
      },
    }));
    const states: ActionState[] = [];
    const actions: (() => void)[] = [];
    const Probe = () => {
      const state = useStore(store);
      const selectedAction = useStore(store, (value) => value.increment);
      states.push(state);
      actions.push(state.increment, selectedAction);
      return createElement("p", null, `${state.n}:${typeof state.increment}:${typeof selectedAction}`);
    };

    expect(renderToString(createElement(Probe))).toContain("1:function:function");
    expect(renderToString(createElement(Probe))).toContain("1:function:function");
    const firstState = states[0];
    const secondState = states[1];
    const firstAction = actions[0];
    if (firstState === undefined || secondState === undefined || firstAction === undefined) {
      throw new Error("server action views were not captured");
    }
    expect(secondState).toBe(firstState);
    expect(Object.hasOwn(firstState, "callback")).toBe(false);
    expect(actions.every((action) => action === firstAction)).toBe(true);
    expect(unwrapProxy(firstState, true)).toBe(firstState);
    expect(Object.isFrozen(firstState)).toBe(true);
    expect(Object.isFrozen(firstState.nested)).toBe(true);

    store.state.n = 2;
    expect(renderToString(createElement(Probe))).toContain("2:function:function");
    const updatedState = states.at(-1);
    const updatedAction = actions.at(-1);
    if (updatedState === undefined || updatedAction === undefined) {
      throw new Error("updated server action view was not captured");
    }
    expect(updatedState).not.toBe(firstState);
    expect(updatedAction).toBe(firstAction);

    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(Probe));
    document.body.append(container);
    const recoverableError = mock((_error: unknown) => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, createElement(Probe), { onRecoverableError: recoverableError });
        await Promise.resolve();
      });
      expect(recoverableError).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      if (root !== undefined) {
        await act(async () => {
          root?.unmount();
        });
      }
      container.remove();
      errorSpy.mockRestore();
    }
  });

  it("preserves actions inside reactive collection server snapshots", () => {
    type Item = { value: number; increment: () => void };
    const increment = () => {};
    const item: Item = { value: 1, increment };
    const store = createStore({
      itemsById: proxyMap<string, Item>([["a", item]]),
      selectedItems: proxySet<Item>([item]),
    });
    const Probe = () => {
      const state = useStore(store);
      const mappedItem = state.itemsById.get("a");
      const selectedItem = [...state.selectedItems][0];
      return createElement(
        "p",
        null,
        [
          typeof mappedItem?.increment,
          typeof selectedItem?.increment,
          state.itemsById instanceof Map,
          state.selectedItems instanceof Set,
          mappedItem?.increment === increment,
          selectedItem?.increment === increment,
          Object.isFrozen(state.itemsById),
          Object.isFrozen(state.selectedItems),
          Object.hasOwn(state.itemsById, "set"),
          Object.hasOwn(state.selectedItems, "add"),
        ].join(":"),
      );
    };

    expect(renderToString(createElement(Probe))).toContain(
      "function:function:true:true:true:true:true:true:true:true",
    );
  });

  it("hydrate applies one batched merge with deepMerge semantics", () => {
    const store = createStore({ user: { name: "x", age: 1 }, list: [1, 2] });
    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (s) => `${s.user.name}:${s.list.length}`),
    );
    expect(result.current.count).toEqual(1);

    act(() => {
      hydrate(store, { user: { name: "server" }, list: [9] });
    });

    expect(result.current.count).toEqual(2);
    expect(store.state.user.name).toEqual("server");
    expect(store.state.user.age).toEqual(1);
    expect(store.state.list).toEqual([9]);

    const beforeNestedMerge = snapshot(store);
    act(() => {
      hydrate(store, { user: { name: "nested-only" } });
    });

    expect(result.current.count).toEqual(3);
    expect(snapshot(store)).not.toBe(beforeNestedMerge);
  });

  it("hydrate does not persist the hydration burst; later mutations persist", async () => {
    const key = "ssr-hydrate-persist";
    try {
      const store = createStore({ n: 0 }, { persist: key });

      hydrate(store, { n: 42 });
      await Promise.resolve();
      expect(localStorage.getItem(key)).toBeNull();

      store.state.n = 7;
      await disposePersistence(store);
      expect(JSON.parse(readPersistedValue(key))).toEqual(persistenceEnvelope({ n: 7 }));
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("hydrate overwrites overlapping persisted keys (explicit intent wins)", () => {
    const key = "ssr-hydrate-order";
    try {
      localStorage.setItem(key, serializedPersistenceEnvelope({ n: 1, keep: "persisted" }));
      const store = createStore({ n: 0, keep: "" }, { persist: key });
      expect(store.state.n).toEqual(1);

      hydrate(store, { n: 99 });

      expect(store.state.n).toEqual(99);
      expect(store.state.keep).toEqual("persisted");
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("async persist resolution applies after hydrate (sync-only ordering guarantee)", async () => {
    let resolveGet: ((value: string | null) => void) | undefined;
    const adapter = {
      getItem: () =>
        new Promise<string | null>((resolve) => {
          resolveGet = resolve;
        }),
      setItem: () => {},
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "ssr-async-order", storage: adapter } });

    hydrate(store, { n: 42 });
    expect(store.state.n).toEqual(42);

    if (resolveGet === undefined) throw new Error("persistence read did not start");
    resolveGet(serializedPersistenceEnvelope({ n: 7 }));
    await persistReady(store);

    expect(store.state.n).toEqual(7);
  });

  it("dev-warns and skips getter-backed keys in hydrate data", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createStore({
        n: 2,
        get double() {
          return this.n * 2;
        },
      });

      hydrate(store, { n: 5, double: 999 });

      expect(store.state.n).toEqual(5);
      expect(store.state.double).toEqual(10);
      expect(
        warnSpy.mock.calls.some(([message]) =>
          String(message).includes('hydrate() skipped getter-backed key "double"'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("createStoreContext", () => {
  it("factory mode isolates providers and hydrates data before first render", () => {
    const appContext = createStoreContext(() => createStore({ n: 0 }));
    const Probe = () =>
      createElement(
        "span",
        null,
        appContext.useStore((s) => s.n),
      );
    const App = (props: { data?: { n: number } }) =>
      createElement(appContext.Provider, { data: props.data }, createElement(Probe));

    expect(renderToString(createElement(App, { data: { n: 7 } }))).toContain("7");
    expect(renderToString(createElement(App, { data: { n: 9 } }))).toContain("9");
  });

  it("rejects Provider data for singleton and caller-provided stores without mutating them", () => {
    const singleton = createStore({ n: 1 });
    const singletonContext = createStoreContext(singleton);
    const SingletonProbe = () =>
      createElement(
        "span",
        null,
        singletonContext.useStore((state) => state.n),
      );
    expect(renderToString(createElement(SingletonProbe))).toContain("1");

    const singletonElement = Reflect.apply(createElement, undefined, [
      singletonContext.Provider,
      { data: { n: 7 } },
    ]);

    expect(() => renderToString(singletonElement)).toThrow(
      "statelift: Provider cannot apply data to an existing store; call hydrate(store, data) before rendering",
    );
    expect(singleton.state.n).toBe(1);

    const supplied = createStore({ n: 2 });
    const factoryContext = createStoreContext(() => createStore({ n: 0 }));
    const suppliedElement = Reflect.apply(createElement, undefined, [
      factoryContext.Provider,
      { store: supplied, data: { n: 8 } },
    ]);

    expect(() => renderToString(suppliedElement)).toThrow(
      "statelift: Provider cannot apply data to an existing store; call hydrate(store, data) before rendering",
    );
    expect(supplied.state.n).toBe(2);
  });

  it("leases manual persistence for a factory Provider mount", async () => {
    const getItem = mock(() => null);
    const setItem = mock((_key: string, _value: string) => {});
    let mountedStore: Store<{ n: number }> | undefined;
    const appContext = createStoreContext(() =>
      createStore(
        { n: 0 },
        {
          persist: {
            key: "provider-manual",
            storage: { getItem, setItem, removeItem: () => {} },
            activation: "manual",
          },
        },
      ),
    );
    const Probe = () => {
      mountedStore = appContext.useStoreInstance();
      return null;
    };

    expect(getItem).not.toHaveBeenCalled();
    const mounted = render(createElement(appContext.Provider, {}, createElement(Probe)));
    expect(getItem).toHaveBeenCalledTimes(1);
    const activeStore = mountedStore;
    if (activeStore === undefined) throw new Error("Provider did not publish its store");

    await act(async () => {
      activeStore.state.n = 1;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setItem).toHaveBeenCalledTimes(1);

    mounted.unmount();
    activeStore.state.n = 2;
    await Promise.resolve();
    await Promise.resolve();
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("activates manual persistence before descendant passive effects", async () => {
    type EffectStoreState = { n: number; setN: (value: number) => void };
    const writes: string[] = [];
    let mountedStore: Store<EffectStoreState> | undefined;
    const appContext = createStoreContext(() =>
      createStore(
        (root: EffectStoreState) => ({
          n: 0,
          setN: (value) => {
            root.n = value;
          },
        }),
        {
          persist: {
            key: "provider-effect-write",
            storage: {
              getItem: () => serializedPersistenceEnvelope({ n: 1 }),
              setItem: (_key: string, value: string) => {
                writes.push(value);
              },
              removeItem: () => {},
            },
            activation: "manual",
          },
        },
      ),
    );
    const Probe = () => {
      const store = appContext.useStoreInstance();
      useEffect(() => {
        mountedStore = store;
        store.state.setN(7);
      }, [store]);
      return null;
    };

    const mounted = render(createElement(appContext.Provider, {}, createElement(Probe)));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const activeStore = mountedStore;
    if (activeStore === undefined) throw new Error("Provider did not publish its store");
    expect(activeStore.state.n).toBe(7);
    const lastWrite = writes.at(-1);
    if (lastWrite === undefined) throw new Error("descendant mount write was not persisted");
    expect(JSON.parse(lastWrite)).toEqual(persistenceEnvelope({ n: 7 }));
    mounted.unmount();
  });

  it("rejects immediate persistence from a factory and disposes the unpublished store", async () => {
    const setItem = mock((_key: string, _value: string) => {});
    let createdStore: Store<{ n: number }> | undefined;
    const appContext = createStoreContext(() => {
      createdStore = createStore(
        { n: 0 },
        {
          persist: {
            key: "provider-immediate",
            storage: { getItem: () => null, setItem, removeItem: () => {} },
          },
        },
      );
      return createdStore;
    });

    expect(() => renderToString(createElement(appContext.Provider, {}))).toThrow(/activation: "manual"/);
    if (createdStore === undefined) throw new Error("factory did not create its store");
    createdStore.state.n = 1;
    await Promise.resolve();
    await Promise.resolve();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps one factory-created store across parent re-renders", () => {
    const appContext = createStoreContext(() => createStore({ n: 0 }));
    const instances: Store<{ n: number }>[] = [];
    const Probe = () => {
      instances.push(appContext.useStoreInstance());
      return null;
    };
    const App = () => createElement(appContext.Provider, {}, createElement(Probe));

    const mounted = render(createElement(App));
    mounted.rerender(createElement(App));

    expect(instances.length).toBeGreaterThanOrEqual(2);
    expect(new Set(instances).size).toBe(1);
    mounted.unmount();
  });

  it("moves the manual persistence lease when the supplied store changes", async () => {
    const makeLeaseStore = (key: string) => {
      const writes: string[] = [];
      let notifyWrite: (() => void) | null = null;
      const nextWrite = () =>
        new Promise<void>((resolve) => {
          notifyWrite = resolve;
        });
      const store = createStore(
        { n: 0 },
        {
          persist: {
            key,
            storage: {
              getItem: () => null,
              setItem: (_key: string, value: string) => {
                writes.push(value);
                notifyWrite?.();
                notifyWrite = null;
              },
              removeItem: () => {},
            },
            activation: "manual",
          },
        },
      );
      return { store, writes, nextWrite };
    };
    const a = makeLeaseStore("lease-move-a");
    const b = makeLeaseStore("lease-move-b");
    const appContext = createStoreContext(() => createStore({ n: 0 }));

    const mounted = render(createElement(appContext.Provider, { store: a.store }));
    await act(async () => {
      const wrote = a.nextWrite();
      a.store.state.n = 1;
      await wrote;
    });
    expect(a.writes.length).toEqual(1);

    mounted.rerender(createElement(appContext.Provider, { store: b.store }));
    await act(async () => {
      const wrote = b.nextWrite();
      a.store.state.n = 2;
      b.store.state.n = 1;
      await wrote;
    });
    expect(a.writes.length).toEqual(1);
    expect(b.writes.length).toEqual(1);

    mounted.unmount();
  });

  it("factory mode without a Provider throws a descriptive error", () => {
    const appContext = createStoreContext(() => createStore({ n: 0 }));
    const Probe = () => {
      appContext.useStoreInstance();
      return null;
    };

    expect(() => renderToString(createElement(Probe))).toThrow(/no store in context/);
  });
});

describe("consumer delivery and setup", () => {
  it("delivers selector subscribers before plain store listeners", () => {
    const store = createStore({ n: 0 });
    const delivery: string[] = [];
    const unsubscribeFirst = subscribe(
      store,
      (state) => state.n,
      () => delivery.push("first"),
    );
    const unsubscribeSecond = subscribe(
      store,
      (state) => state.n,
      () => delivery.push("second"),
    );
    const unsubscribeListener = subscribe(store, () => delivery.push("listener"));

    store.state.n = 1;

    expect(delivery).toEqual(["first", "second", "listener"]);
    unsubscribeFirst();
    unsubscribeSecond();
    unsubscribeListener();
  });

  it("drains reentrant computeds and consumers before plain listeners", () => {
    const delivery: string[] = [];
    const store = createStore((root: { trigger: number; source: number; readonly doubled: number }) => ({
      trigger: 0,
      source: 1,
      get doubled() {
        delivery.push(`computed:${root.source}`);
        return root.source * 2;
      },
    }));
    expect(store.state.doubled).toBe(2);
    delivery.length = 0;

    const first = createConsumer(store, () => {
      delivery.push("first:start");
      store.state.source = 2;
      delivery.push("first:end");
    });
    const second = createConsumer(store, () => {
      delivery.push(`second:${store.state.doubled}`);
    });
    void first.proxy.trigger;
    void second.proxy.trigger;
    const unsubscribeListener = subscribe(store, () => {
      delivery.push(`listener:${store.state.doubled}`);
    });

    batch(store, () => {
      store.state.trigger = 1;
    });

    expect(delivery).toEqual(["first:start", "first:end", "computed:2", "second:4", "listener:4"]);
    first.destroy();
    second.destroy();
    unsubscribeListener();
  });

  it("restores outer tracking after a nested consumer track", () => {
    const store = createStore({ outer: 0, inner: 0, after: 0 });
    const outerCallback = mock();
    const innerCallback = mock();
    const outer = createConsumer(store, outerCallback);
    const inner = createConsumer(store, innerCallback);

    expect(
      outer.track((state) => {
        const outerValue = state.outer;
        inner.track((innerState) => innerState.inner);
        return outerValue + state.after;
      }),
    ).toBe(0);

    store.state.inner = 1;
    expect(innerCallback).toHaveBeenCalledTimes(1);
    expect(outerCallback).not.toHaveBeenCalled();

    store.state.after = 1;
    expect(outerCallback).toHaveBeenCalledTimes(1);

    outer.destroy();
    inner.destroy();
  });

  it("drains independent and reentrant consumer work before surfacing the first error", () => {
    const store = createStore({ n: 0 });
    let shouldThrow = true;
    const first = createConsumer(store, () => {
      if (shouldThrow) throw new Error("consumer failed");
    });
    const secondCallback = mock();
    const second = createConsumer(store, secondCallback);
    const listener = mock();
    const unsubscribe = subscribe(store, listener);
    void first.proxy.n;
    void second.proxy.n;

    expect(() => {
      store.state.n = 1;
    }).toThrow("consumer failed");
    expect(secondCallback).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    shouldThrow = false;
    store.state.n = 2;
    expect(secondCallback).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2);

    first.destroy();
    second.destroy();
    unsubscribe();
  });

  it("skips a queued consumer that is destroyed before its turn", () => {
    const store = createStore({ n: 0 });
    const destroySecond = mock();
    const first = createConsumer(store, destroySecond);
    const secondCallback = mock();
    const second = createConsumer(store, secondCallback);
    destroySecond.mockImplementation(second.destroy);
    void first.proxy.n;
    void second.proxy.n;

    batch(store, () => {
      store.state.n = 1;
    });

    expect(secondCallback).not.toHaveBeenCalled();
    first.destroy();
  });

  it("moves refreshed dependencies to the delivery tail", () => {
    const store = createStore({ firstOnly: 0, shared: 0 });
    const delivery: string[] = [];
    const unsubscribeFirst = subscribe(
      store,
      (state) => state.firstOnly + state.shared,
      () => delivery.push("first"),
    );
    const unsubscribeSecond = subscribe(
      store,
      (state) => state.shared,
      () => delivery.push("second"),
    );

    store.state.firstOnly = 1;
    delivery.length = 0;
    store.state.shared = 1;

    expect(delivery).toEqual(["second", "first"]);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("delivers once after same-consumer nested tracking rereads a dependency", () => {
    const store = createStore({ shared: 0 });
    const delivery: string[] = [];
    const first = createConsumer(store, () => delivery.push("first"));
    const second = createConsumer(store, () => delivery.push("second"));
    first.track((state) => state.shared);
    second.track((state) => state.shared);

    first.track((state) => {
      first.track((nestedState) => nestedState.shared);
      return state.shared;
    });
    store.state.shared = 1;

    expect(delivery).toEqual(["second", "first"]);
    first.destroy();
    second.destroy();
  });

  it("keeps reads before and after active same-consumer nested tracking", () => {
    const store = createStore({ before: 1, nested: 2, after: 3 });
    const callback = mock();
    const consumer = createConsumer(store, callback);

    expect(
      consumer.track((state) => {
        const before = state.before;
        const nested = consumer.track((nestedState) => nestedState.nested);
        return before + nested + state.after;
      }),
    ).toBe(6);

    store.state.before = 2;
    store.state.nested = 3;
    store.state.after = 4;

    expect(callback).toHaveBeenCalledTimes(3);
    consumer.destroy();
  });

  it("keeps active same-consumer dependencies when an inner error is caught", () => {
    const store = createStore({ before: 1, nested: 2, after: 3 });
    const callback = mock();
    const consumer = createConsumer(store, callback);

    consumer.track((state) => {
      const before = state.before;
      try {
        consumer.track((nestedState) => {
          const nested = nestedState.nested;
          throw new Error(`nested ${nested}`);
        });
      } catch (error) {
        expect(String(error)).toContain("nested 2");
      }
      return before + state.after;
    });

    store.state.before = 2;
    store.state.nested = 3;
    store.state.after = 4;

    expect(callback).toHaveBeenCalledTimes(3);
    consumer.destroy();
  });

  it("finalizes active same-consumer dependencies after an uncaught inner error", () => {
    const store = createStore({ before: 1, nested: 2, after: 3 });
    const callback = mock();
    const consumer = createConsumer(store, callback);

    expect(() =>
      consumer.track((state) => {
        const before = state.before;
        consumer.track((nestedState) => {
          const nested = nestedState.nested;
          throw new Error(`nested ${nested}`);
        });
        return before + state.after;
      }),
    ).toThrow("nested 2");

    store.state.before = 2;
    store.state.nested = 3;
    store.state.after = 4;

    expect(callback).toHaveBeenCalledTimes(2);
    consumer.destroy();
  });

  it("restores array iteration ownership after a callback throws", () => {
    const store = createStore({ list: [1, 2] });
    const callback = mock();
    const consumer = createConsumer(store, callback);
    const failIteration = (): never => {
      throw new Error("iteration failed");
    };

    expect(() => consumer.track((state) => state.list.map(failIteration))).toThrow("iteration failed");
    consumer.track((state) => state.list[0]);
    store.state.list[0] = 3;

    expect(callback).toHaveBeenCalledTimes(1);
    consumer.destroy();
  });

  it("retracks reordered and repeated dependencies without duplicate delivery", () => {
    const store = createStore({ a: 1, b: 2, c: 3 });
    const callback = mock();
    const consumer = createConsumer(store, callback);

    consumer.track((state) => state.a + state.b + state.c);
    consumer.track((state) => state.c + state.a + state.c);

    store.state.b = 4;
    expect(callback).not.toHaveBeenCalled();

    store.state.c = 5;
    expect(callback).toHaveBeenCalledTimes(1);

    consumer.destroy();
  });

  it("retains only dependencies read by a failed selector rerun", () => {
    const store = createStore({ useB: false, a: 1, b: 10 });
    const captured: unknown[] = [];
    const queueMicrotaskSpy = spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      try {
        task();
      } catch (error) {
        captured.push(error);
      }
    });
    let shouldThrow = true;
    let selectorRuns = 0;
    const callback = mock();
    let unsubscribe = () => {};

    try {
      unsubscribe = subscribe(
        store,
        (state) => {
          selectorRuns++;
          if (!state.useB) return state.a;
          const value = state.b;
          if (shouldThrow) throw new Error("selector failed");
          return value;
        },
        callback,
      );

      store.state.useB = true;
      expect(captured).toHaveLength(1);
      expect(String(captured[0])).toContain("selector failed");
      const runsAfterFailure = selectorRuns;

      store.state.a = 2;
      expect(selectorRuns).toBe(runsAfterFailure);

      shouldThrow = false;
      store.state.b = 11;
      expect(selectorRuns).toBe(runsAfterFailure + 1);
      expect(callback).toHaveBeenCalledWith(11, 1);
    } finally {
      unsubscribe();
      queueMicrotaskSpy.mockRestore();
    }
  });

  it("does not notify a retained dependency written before it is reread", () => {
    const store = createStore({ useNew: false, oldValue: 0, newValue: 1 });
    let selectorRuns = 0;
    const callback = mock();
    const unsubscribe = subscribe(
      store,
      (state) => {
        selectorRuns++;
        if (!state.useNew) return state.oldValue;
        state.oldValue = 10;
        return state.newValue;
      },
      callback,
    );

    store.state.useNew = true;

    expect(selectorRuns).toBe(2);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(1, 0);

    store.state.oldValue = 11;
    expect(selectorRuns).toBe(2);
    unsubscribe();
  });

  it("delivers both ordered transitions when a selector callback mutates its selection", () => {
    const store = createStore({ n: 0 });
    const transitions: [number, number][] = [];
    const unsubscribe = subscribe(
      store,
      (state) => state.n,
      (value, previous) => {
        transitions.push([value, previous]);
        if (value === 1) store.state.n = 2;
      },
    );

    store.state.n = 1;

    expect(transitions).toEqual([
      [1, 0],
      [2, 1],
    ]);
    unsubscribe();
  });

  it("keeps deferred consumers local until activation and catches the version race", () => {
    const store = createStore({ n: 0 });
    const callback = mock();
    const consumer = createConsumer(store, callback, { deferRegistration: true });

    expect(consumer.proxy.n).toBe(0);
    store.state.n = 1;
    expect(callback).not.toHaveBeenCalled();

    consumer.activate();
    expect(callback).toHaveBeenCalledTimes(1);
    consumer.refreshDependencies();
    expect(consumer.proxy.n).toBe(1);
    store.state.n = 2;
    expect(callback).toHaveBeenCalledTimes(2);
    consumer.destroy();
  });

  it("does not report a deferred version race after rereading current state", () => {
    const store = createStore({ n: 0 });
    const callback = mock();
    const consumer = createConsumer(store, callback, { deferRegistration: true });

    expect(consumer.proxy.n).toBe(0);
    store.state.n = 1;
    expect(consumer.proxy.n).toBe(1);

    consumer.activate();

    expect(callback).not.toHaveBeenCalled();
    consumer.destroy();
  });

  it("reports a deferred version race when only one dependency is reread", () => {
    const store = createStore({ a: 0, b: 0 });
    const callback = mock();
    const consumer = createConsumer(store, callback, { deferRegistration: true });

    expect(consumer.proxy.a).toBe(0);
    expect(consumer.proxy.b).toBe(0);
    store.state.b = 1;
    expect(consumer.proxy.a).toBe(0);

    consumer.activate();

    expect(callback).toHaveBeenCalledTimes(1);
    consumer.destroy();
  });

  it("restores tracking after an active consumer destroys itself", () => {
    const store = createStore({ first: 0, second: 0 });
    const firstCallback = mock();
    const secondCallback = mock();
    const first = createConsumer(store, firstCallback);
    const second = createConsumer(store, secondCallback);

    first.track((state) => {
      const value = state.first;
      first.destroy();
      return value;
    });
    expect(store.state.second).toBe(0);
    second.track((state) => state.second);

    store.state.first = 1;
    store.state.second = 1;

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledTimes(1);
    second.destroy();
  });

  it("removes registrations when subscription setup throws", () => {
    const store = createStore({ n: 0 });
    const selector = mock(() => {
      void store.state.n;
      throw new Error("selector setup failed");
    });
    expect(() => subscribe(store, selector, () => {})).toThrow("selector setup failed");

    const immediate = mock(() => {
      throw new Error("immediate failed");
    });
    expect(() => subscribe(store, immediate, { fireImmediately: true })).toThrow("immediate failed");

    const selectorImmediate = mock(() => {
      throw new Error("selector immediate failed");
    });
    expect(() => subscribe(store, (state) => state.n, selectorImmediate, { fireImmediately: true })).toThrow(
      "selector immediate failed",
    );

    store.state.n = 1;
    expect(selector).toHaveBeenCalledTimes(1);
    expect(immediate).toHaveBeenCalledTimes(1);
    expect(selectorImmediate).toHaveBeenCalledTimes(1);
  });

  it("removes every source consumer when computed construction throws", () => {
    const left = createStore({ n: 1 });
    const right = createStore({ n: 2 });
    const derive = mock(
      ({ left: leftState, right: rightState }: { left: { n: number }; right: { n: number } }) => {
        void leftState.n;
        void rightState.n;
        throw new Error("derive failed");
      },
    );

    expect(() => computed({ left, right }, derive)).toThrow("derive failed");
    left.state.n = 3;
    right.state.n = 4;

    expect(derive).toHaveBeenCalledTimes(1);
  });
});

describe("state application graphs and boundaries", () => {
  it("treats own __proto__ keys as data across hydrate, restore, and persistence", () => {
    const payload: unknown = JSON.parse('{"__proto__":{"safe":true},"nested":{"__proto__":{"deep":true}}}');
    if (payload === null || typeof payload !== "object") {
      throw new Error("prototype fixture is not an object");
    }
    const hydratedNested: Record<string, unknown> = {};
    const hydrated = createStore({ nested: hydratedNested });
    Reflect.apply(hydrate, undefined, [hydrated, payload]);

    expect(Reflect.get(Object.prototype, "safe")).toBeUndefined();
    expect(Reflect.get(Object.prototype, "deep")).toBeUndefined();
    expect(Object.hasOwn(hydrated.state, "__proto__")).toBe(true);
    expect(Object.hasOwn(hydrated.state.nested, "__proto__")).toBe(true);

    const restoredNested: Record<string, unknown> = {};
    const restored = createStore({ nested: restoredNested });
    Reflect.apply(restore, undefined, [restored, payload]);
    expect(Object.hasOwn(restored.state, "__proto__")).toBe(true);
    expect(Object.hasOwn(restored.state.nested, "__proto__")).toBe(true);

    const persistedNested: Record<string, unknown> = {};
    const persisted = createStore(
      { nested: persistedNested },
      {
        persist: {
          key: "proto-import",
          storage: {
            getItem: () => serializedPersistenceEnvelope(payload),
            setItem: () => {},
            removeItem: () => {},
          },
        },
      },
    );
    expect(Object.hasOwn(persisted.state, "__proto__")).toBe(true);
    expect(Reflect.get(Object.prototype, "safe")).toBeUndefined();
  });

  it("replaces opaque values and reconstructs isolated frozen data during restore", () => {
    const oldDate = new Date("2020-01-01");
    const newDate = new Date("2024-01-01");
    const oldFrozen: Readonly<{ value: number }> = Object.freeze({ value: 1 });
    const newFrozen: Readonly<{ value: number }> = Object.freeze({ value: 2 });
    const oldFrozenArray: readonly number[] = Object.freeze([1, 2]);
    const newFrozenArray: readonly number[] = Object.freeze([3, 4]);
    const oldMap = new Map([["old", 1]]);
    const newMap = new Map([["new", 2]]);
    const oldBytes = new Uint8Array([1, 2]);
    const newBytes = new Uint8Array([3, 4]);
    const oldPromise = Promise.resolve("old");
    const newPromise = Promise.resolve("new");
    const store = createStore({
      date: oldDate,
      map: oldMap,
      frozen: oldFrozen,
      frozenArray: oldFrozenArray,
      bytes: oldBytes,
      promise: oldPromise,
    });
    const checkpoint = snapshot(store);

    hydrate(store, {
      date: newDate,
      map: newMap,
      frozen: newFrozen,
      frozenArray: newFrozenArray,
      bytes: newBytes,
      promise: newPromise,
    });
    expect(store.state.date).toBe(newDate);
    expect(store.state.map).toBe(newMap);
    expect(store.state.frozen).toBe(newFrozen);
    expect(store.state.frozenArray).toBe(newFrozenArray);
    expect(store.state.bytes).toBe(newBytes);
    expect(store.state.promise).toBe(newPromise);

    restore(store, checkpoint);
    expect(store.state.date).toBe(oldDate);
    expect(store.state.map).toBe(oldMap);
    expect(store.state.frozen).not.toBe(oldFrozen);
    expect(store.state.frozen).toEqual({ value: 1 });
    expect(store.state.frozenArray).not.toBe(oldFrozenArray);
    expect(store.state.frozenArray).toEqual([1, 2]);
    expect(store.state.bytes).toBe(oldBytes);
    expect(store.state.promise).toBe(oldPromise);
  });

  it("preserves Date values returned by a custom persistence serializer", () => {
    const restoredDate = new Date("2025-01-01");
    const store = createStore(
      { date: new Date("2020-01-01") },
      {
        persist: {
          key: "opaque-serializer",
          storage: {
            getItem: () => "encoded",
            setItem: () => {},
            removeItem: () => {},
          },
          serializer: {
            stringify: JSON.stringify,
            parse: () => persistenceEnvelope({ date: restoredDate }),
          },
        },
      },
    );

    expect(store.state.date).toBe(restoredDate);
  });

  it("keeps an equal opaque reference as a complete hydration no-op", () => {
    const date = new Date("2025-01-01");
    const store = createStore({ date });
    const listener = mock();
    const unsubscribe = subscribe(store, listener);
    const before = snapshot(store);

    hydrate(store, { date });

    expect(listener).not.toHaveBeenCalled();
    expect(snapshot(store)).toBe(before);
    unsubscribe();
  });

  it("restores cycles, aliases, and code nested inside arrays", () => {
    type Item = { value: number; increment: () => void; readonly double: number };
    type GraphState = {
      self: unknown;
      child: { parent: unknown };
      left: { value: number };
      right: { value: number };
      items: Item[];
      links: unknown[];
      references: ProxyMap<string, unknown>;
      keyedReferences: ProxyMap<object, unknown>;
    };
    const item = {
      value: 1,
      increment() {
        this.value++;
      },
      get double() {
        return this.value * 2;
      },
    };
    const store = createStore<GraphState>({
      self: null,
      child: { parent: null },
      left: { value: 1 },
      right: { value: 1 },
      items: [item],
      links: [],
      references: proxyMap<string, unknown>(),
      keyedReferences: proxyMap<object, unknown>(),
    });
    const identityKey = {};
    store.state.self = store.state;
    store.state.child.parent = store.state;
    store.state.right = store.state.left;
    store.state.links.push(store.state);
    store.state.references.set("root", store.state);
    store.state.keyedReferences.set(identityKey, store.state.left);
    const checkpoint = snapshot(store);

    store.state.self = null;
    store.state.child.parent = null;
    store.state.right = { value: 9 };
    store.state.links = [];
    store.state.references.clear();
    store.state.keyedReferences.clear();
    Object.defineProperty(store.state.items, "stale", {
      value: true,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const liveItem = store.state.items[0];
    if (!liveItem) throw new Error("live restore fixture item is missing");
    liveItem.value = 9;
    const listener = mock();
    const unsubscribe = subscribe(store, listener);
    restore(store, checkpoint);

    if (
      typeof store.state.self !== "object" ||
      store.state.self === null ||
      typeof store.state.child.parent !== "object" ||
      store.state.child.parent === null
    ) {
      throw new Error("restore did not recreate graph references");
    }
    expect(unwrapProxy(store.state.self, true)).toBe(unwrapProxy(store.state, true));
    expect(unwrapProxy(store.state.child.parent, true)).toBe(unwrapProxy(store.state, true));
    expect(unwrapProxy(store.state.left, true)).toBe(unwrapProxy(store.state.right, true));
    const restoredLink = store.state.links[0];
    const restoredReference = store.state.references.get("root");
    if (typeof restoredLink !== "object" || restoredLink === null) {
      throw new Error("array cycle was not restored");
    }
    if (typeof restoredReference !== "object" || restoredReference === null) {
      throw new Error("collection cycle was not restored");
    }
    expect(unwrapProxy(restoredLink, true)).toBe(unwrapProxy(store.state, true));
    expect(unwrapProxy(restoredReference, true)).toBe(unwrapProxy(store.state, true));
    const restoredKey = [...store.state.keyedReferences.keys()][0];
    if (typeof restoredKey !== "object" || restoredKey === null) {
      throw new Error("keyed collection key was not restored");
    }
    expect(unwrapProxy(restoredKey, true)).toBe(identityKey);
    const keyedReference = store.state.keyedReferences.get(identityKey);
    if (typeof keyedReference !== "object" || keyedReference === null) {
      throw new Error("keyed collection reference was not restored");
    }
    expect(unwrapProxy(keyedReference, true)).toBe(unwrapProxy(store.state.left, true));
    expect(Object.hasOwn(store.state.items, "stale")).toBe(false);
    const restoredItem = store.state.items[0];
    if (!restoredItem) throw new Error("restored fixture item is missing");
    expect(restoredItem.double).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    restoredItem.increment();
    expect(restoredItem.value).toBe(2);
  });

  it("preserves own __proto__ keys in snapshot and dehydrate outputs", () => {
    const arrayValue: Record<string, unknown> = {};
    const collectionValue: Record<string, unknown> = {};
    const source: {
      nested: Record<string, unknown>;
      items: Record<string, unknown>[];
      values: ProxyMap<string, Record<string, unknown>>;
    } = {
      nested: {},
      items: [arrayValue],
      values: proxyMap<string, Record<string, unknown>>([["entry", collectionValue]]),
    };
    Object.defineProperty(source, "__proto__", {
      value: { safe: true },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    Object.defineProperty(source.nested, "__proto__", {
      value: { deep: true },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    Object.defineProperty(arrayValue, "__proto__", {
      value: { array: true },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    Object.defineProperty(collectionValue, "__proto__", {
      value: { collection: true },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const store = createStore(source);

    const snap = snapshot(store);
    const dehydrated = dehydrate(store);
    const snapItem = snap.items[0];
    const snapCollectionValue = snap.values.get("entry");
    if (!snapItem || !snapCollectionValue) throw new Error("snapshot fixtures are missing");

    expect(Object.hasOwn(snap, "__proto__")).toBe(true);
    expect(Object.hasOwn(snap.nested, "__proto__")).toBe(true);
    expect(Object.hasOwn(snapItem, "__proto__")).toBe(true);
    expect(Object.hasOwn(snapCollectionValue, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);

    const serialized = JSON.stringify(dehydrated);
    const restored = createStore<{
      nested: Record<string, unknown>;
      items: Record<string, unknown>[];
      values: ProxyMap<string, Record<string, unknown>>;
    }>({
      nested: {},
      items: [{}],
      values: proxyMap<string, Record<string, unknown>>(),
    });
    Reflect.apply(hydrate, undefined, [restored, JSON.parse(serialized)]);
    const restoredItem = restored.state.items[0];
    const restoredCollectionValue = restored.state.values.get("entry");
    if (!restoredItem || !restoredCollectionValue) throw new Error("round-trip fixtures are missing");
    expect(Object.hasOwn(restored.state, "__proto__")).toBe(true);
    expect(Object.hasOwn(restored.state.nested, "__proto__")).toBe(true);
    expect(Object.hasOwn(restoredItem, "__proto__")).toBe(true);
    expect(Object.hasOwn(restoredCollectionValue, "__proto__")).toBe(true);
  });
});

describe("persistence ordering and origins", () => {
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it("commits a queued write before rehydrate reads storage", async () => {
    const calls: string[] = [];
    let stored: string | null = null;
    const storage = {
      getItem: () => {
        calls.push("read");
        return stored;
      },
      setItem: (_key: string, value: string) => {
        calls.push("write");
        stored = value;
      },
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "queued-before-read", storage } });
    calls.length = 0;

    store.state.n = 1;
    await rehydrate(store);

    expect(calls).toEqual(["write", "read"]);
    expect(store.state.n).toBe(1);
  });

  it("persists an accepted mutation before rethrowing a consumer error", async () => {
    const writes: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        writes.push(value);
      },
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "persist-before-consumer-error", storage } });
    const throwing = createConsumer(store, () => {
      throw new Error("consumer failed");
    });
    void throwing.proxy.n;

    expect(() => {
      store.state.n = 1;
    }).toThrow("consumer failed");
    await disposePersistence(store);

    const persisted = writes.at(-1);
    if (persisted === undefined) throw new Error("accepted mutation was not persisted");
    expect(JSON.parse(persisted)).toEqual(persistenceEnvelope({ n: 1 }));
    throwing.destroy();
  });

  it("drains in-flight and queued writes before rehydrate reads storage", async () => {
    const calls: string[] = [];
    let stored: string | null = null;
    const writes: { resolve: () => void }[] = [];
    const storage = {
      getItem: () => {
        calls.push("read");
        return stored;
      },
      setItem: (_key: string, value: string) =>
        new Promise<void>((resolve) => {
          calls.push("write");
          writes.push({
            resolve: () => {
              stored = value;
              resolve();
            },
          });
        }),
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "inflight-before-read", storage } });
    calls.length = 0;

    store.state.n = 1;
    await flushMicrotasks();
    store.state.n = 2;
    const hydration = rehydrate(store);
    expect(calls).toEqual(["write"]);

    const firstWrite = writes[0];
    if (firstWrite === undefined) throw new Error("first write did not start");
    firstWrite.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["write", "write"]);

    const secondWrite = writes[1];
    if (secondWrite === undefined) throw new Error("queued write did not start");
    secondWrite.resolve();
    await hydration;
    expect(calls).toEqual(["write", "write", "read"]);
    expect(store.state.n).toBe(2);
  });

  it("keeps manual persistence inert outside activation leases and terminal after disposal", async () => {
    const getItem = mock(() => null);
    const setItem = mock((_key: string, _value: string) => {});
    const store = createStore(
      { n: 0 },
      {
        persist: {
          key: "manual-lifecycle",
          storage: { getItem, setItem, removeItem: () => {} },
          activation: "manual",
        },
      },
    );

    store.state.n = 1;
    await flushMicrotasks();
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();

    const releaseFirst = activatePersistence(store);
    const releaseSecond = activatePersistence(store);
    expect(getItem).toHaveBeenCalledTimes(1);
    store.state.n = 2;
    await flushMicrotasks();
    expect(setItem).toHaveBeenCalledTimes(1);

    releaseFirst();
    store.state.n = 3;
    await flushMicrotasks();
    expect(setItem).toHaveBeenCalledTimes(2);

    releaseSecond();
    store.state.n = 4;
    await flushMicrotasks();
    expect(setItem).toHaveBeenCalledTimes(2);

    const releaseBeforeDisposal = activatePersistence(store);
    await disposePersistence(store);
    releaseBeforeDisposal();
    expect(() => activatePersistence(store)).toThrow(/disposed persistence/);
  });

  it("reactivates manual persistence while the first write is in flight and starts the follow-up before disposal", async () => {
    const writes: { value: string; resolve: () => void }[] = [];
    const storage = {
      getItem: () => null,
      setItem: (_key: string, value: string) =>
        new Promise<void>((resolve) => {
          writes.push({ value, resolve });
        }),
      removeItem: () => {},
    };
    const store = createStore(
      { n: 0 },
      { persist: { key: "manual-reactivation", storage, activation: "manual" } },
    );
    const releaseFirst = activatePersistence(store);

    store.state.n = 1;
    await flushMicrotasks();
    expect(writes).toHaveLength(1);

    releaseFirst();
    const releaseSecond = activatePersistence(store);
    store.state.n = 2;
    await flushMicrotasks();
    expect(writes).toHaveLength(1);

    const firstWrite = writes[0];
    if (firstWrite === undefined) throw new Error("first manual write did not start");
    firstWrite.resolve();
    await flushMicrotasks();

    expect(writes).toHaveLength(2);
    const secondWrite = writes[1];
    if (secondWrite === undefined) throw new Error("reactivated follow-up write did not start");
    expect(JSON.parse(secondWrite.value)).toEqual(persistenceEnvelope({ n: 2 }));
    secondWrite.resolve();
    await flushMicrotasks();
    releaseSecond();
    expect(await disposePersistence(store)).toEqual({ flushed: true });
  });

  it("serializes async writes and coalesces pending state to the latest snapshot", async () => {
    const writes: {
      value: string;
      resolve: () => void;
      reject: () => void;
    }[] = [];
    const storage = {
      getItem: () => null,
      setItem: (_key: string, value: string) =>
        new Promise<void>((resolve, reject) => {
          writes.push({ value, resolve, reject: () => reject(new Error("write failed")) });
        }),
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "ordered-writes", storage } });

    store.state.n = 1;
    await flushMicrotasks();
    expect(writes).toHaveLength(1);

    store.state.n = 2;
    store.state.n = 3;
    await flushMicrotasks();
    expect(writes).toHaveLength(1);

    const firstWrite = writes[0];
    if (!firstWrite) throw new Error("first async write was not started");
    firstWrite.resolve();
    await flushMicrotasks();
    expect(writes).toHaveLength(2);
    const secondWrite = writes[1];
    if (!secondWrite) throw new Error("second async write was not started");
    expect(JSON.parse(secondWrite.value)).toEqual(persistenceEnvelope({ n: 3 }));
    secondWrite.resolve();
    await flushMicrotasks();
  });

  it("waits for the next throttle boundary before starting an async follow-up write", async () => {
    jest.useFakeTimers();
    const writes: { value: string; resolve: () => void }[] = [];
    const storage = {
      getItem: () => null,
      setItem: (_key: string, value: string) =>
        new Promise<void>((resolve) => {
          writes.push({ value, resolve });
        }),
      removeItem: () => {},
    };
    const store = createStore(
      { n: 0 },
      { persist: { key: "async-throttle-follow-up", storage, throttle: 20 } },
    );
    try {
      store.state.n = 1;
      jest.advanceTimersByTime(20);
      expect(writes).toHaveLength(1);

      store.state.n = 2;
      const firstWrite = writes[0];
      if (firstWrite === undefined) throw new Error("first throttled write did not start");
      firstWrite.resolve();
      await flushMicrotasks();
      expect(writes).toHaveLength(1);

      jest.advanceTimersByTime(19);
      expect(writes).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(writes).toHaveLength(2);

      const secondWrite = writes[1];
      if (secondWrite === undefined) throw new Error("throttled follow-up write did not start");
      expect(JSON.parse(secondWrite.value)).toEqual(persistenceEnvelope({ n: 2 }));
      secondWrite.resolve();
      await flushMicrotasks();
      expect(await disposePersistence(store)).toEqual({ flushed: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it("lets a later write recover after an async write rejection", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const writes: { resolve: () => void; reject: () => void }[] = [];
    const storage = {
      getItem: () => null,
      setItem: () =>
        new Promise<void>((resolve, reject) => {
          writes.push({ resolve, reject: () => reject(new Error("write failed")) });
        }),
      removeItem: () => {},
    };
    try {
      const store = createStore({ n: 0 }, { persist: { key: "recover-write", storage } });
      store.state.n = 1;
      await flushMicrotasks();
      const firstWrite = writes[0];
      if (!firstWrite) throw new Error("failing async write was not started");
      firstWrite.reject();
      await flushMicrotasks();

      store.state.n = 2;
      await flushMicrotasks();
      expect(writes).toHaveLength(2);
      const secondWrite = writes[1];
      if (!secondWrite) throw new Error("recovery async write was not started");
      secondWrite.resolve();
      await flushMicrotasks();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("uses latest-started-read-wins for overlapping rehydrate calls", async () => {
    const reads: { resolve: (value: string | null) => void; reject: () => void }[] = [];
    const storage = {
      getItem: () =>
        new Promise<string | null>((resolve, reject) => {
          reads.push({ resolve, reject: () => reject(new Error("read failed")) });
        }),
      setItem: () => {},
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "latest-read", storage } });
    const latest = rehydrate(store);

    const latestRead = reads[1];
    const staleRead = reads[0];
    if (!latestRead || !staleRead) throw new Error("overlapping reads were not started");
    latestRead.resolve(serializedPersistenceEnvelope({ n: 2 }));
    await latest;
    expect(store.state.n).toBe(2);

    staleRead.resolve(serializedPersistenceEnvelope({ n: 1 }));
    await flushMicrotasks();
    expect(store.state.n).toBe(2);
  });

  it("ignores stale hydration rejection warnings and completion signals", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const onHydrated = mock();
    const reads: { resolve: (value: string | null) => void; reject: () => void }[] = [];
    const storage = {
      getItem: () =>
        new Promise<string | null>((resolve, reject) => {
          reads.push({ resolve, reject: () => reject(new Error("stale read failed")) });
        }),
      setItem: () => {},
      removeItem: () => {},
    };
    try {
      const store = createStore({ n: 0 }, { persist: { key: "stale-read", storage, onHydrated } });
      const latest = rehydrate(store);
      const latestRead = reads[1];
      const staleRead = reads[0];
      if (!latestRead || !staleRead) throw new Error("overlapping reads were not started");
      latestRead.resolve(null);
      await latest;
      staleRead.reject();
      await flushMicrotasks();

      expect(warnSpy).not.toHaveBeenCalled();
      expect(onHydrated).toHaveBeenCalledTimes(1);
      expect(hasHydrated(store)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("gives partialize a public collection snapshot and retains the slots payload", async () => {
    let written = "";
    const partialize = mock((state: { readonly users: ReadonlyMap<string, number> }) => {
      expect(state.users.get("a")).toBe(1);
      expect([...state.users.entries()]).toEqual([["a", 1]]);
      return { users: state.users };
    });
    const storage = {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        written = value;
      },
      removeItem: () => {},
    };
    const store = createStore(
      { users: proxyMap<string, number>() },
      { persist: { key: "partialize-map", storage, partialize } },
    );

    store.state.users.set("a", 1);
    await flushMicrotasks();

    expect(partialize).toHaveBeenCalledTimes(1);
    expect(JSON.parse(written)).toEqual(
      persistenceEnvelope({ users: { slots: { s0: { key: "a", value: 1 } }, size: 1 } }),
    );
  });

  it("does not echo imported storage data but persists a subscriber's local follow-up", async () => {
    const key = "remote-origin";
    localStorage.removeItem(key);
    try {
      const store = createStore({ n: 0 }, { persist: { key, syncAcrossTabs: true } });
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: serializedPersistenceEnvelope({ n: 1 }),
          storageArea: localStorage,
        }),
      );
      await flushMicrotasks();
      expect(store.state.n).toBe(1);
      expect(localStorage.getItem(key)).toBeNull();

      const unsubscribe = subscribe(store, () => {
        if (store.state.n === 2) store.state.n = 3;
      });
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: serializedPersistenceEnvelope({ n: 2 }),
          storageArea: localStorage,
        }),
      );
      await flushMicrotasks();
      expect(store.state.n).toBe(3);
      const stored = localStorage.getItem(key);
      if (stored === null) throw new Error("local follow-up was not persisted");
      expect(JSON.parse(stored)).toEqual(persistenceEnvelope({ n: 3 }));
      unsubscribe();
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("ignores same-key storage events from another storage area", () => {
    const key = "storage-area";
    const store = createStore({ n: 0 }, { persist: { key, syncAcrossTabs: true } });

    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: serializedPersistenceEnvelope({ n: 9 }),
        storageArea: sessionStorage,
      }),
    );

    expect(store.state.n).toBe(0);
  });
});

describe("React rendering and root boundaries", () => {
  it("does not retain a consumer from a render that throws before subscription", () => {
    const store = createStore({ n: 0 });
    let selectorRuns = 0;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => {
      useStore(store, (state) => {
        selectorRuns++;
        return state.n;
      });
      throw new Error("render failed");
    };
    try {
      expect(() => render(createElement(Broken))).toThrow("render failed");
      const afterRender = selectorRuns;
      store.state.n = 1;
      expect(selectorRuns).toBe(afterRender);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects unsupported roots immediately and preserves null-prototype records", () => {
    expect(() => Reflect.apply(createStore, undefined, [[1, 2]])).toThrow(
      "statelift: createStore root must be a plain record",
    );

    const root: { count: number } = Object.create(null);
    root.count = 1;
    const store = createStore(root);
    expect(Object.getPrototypeOf(unwrapProxy(store.state, true))).toBeNull();
    store.state.count = 2;
    expect(store.state.count).toBe(2);
  });
});

describe("persistence failure recovery", () => {
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it("completes hydration and keeps persistence alive when an async payload fails to apply", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const writes: string[] = [];
    const adapter = {
      getItem: () =>
        Promise.resolve(
          serializedPersistenceEnvelope({
            users: { slots: { s0: { key: "a", value: 1, extra: 2 } }, size: 1 },
          }),
        ),
      setItem: (_key: string, value: string) => {
        writes.push(value);
      },
      removeItem: () => {},
    };
    try {
      const store = createStore(
        { users: proxyMap<string, number>() },
        { persist: { key: "recover-apply", storage: adapter } },
      );
      await persistReady(store);

      expect(hasHydrated(store)).toBe(true);
      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes("failed to apply persisted state")),
      ).toBe(true);

      store.state.users.set("b", 2);
      await disposePersistence(store);
      expect(writes.length).toEqual(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns instead of throwing when a synced cross-tab payload fails to apply", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const key = "recover-sync-tab";
    try {
      const store = createStore(
        { users: proxyMap<string, number>([["kept", 1]]) },
        { persist: { key, syncAcrossTabs: true } },
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: serializedPersistenceEnvelope({
            users: { slots: { s0: { key: "a", value: 1, extra: 2 } }, size: 1 },
          }),
          storageArea: localStorage,
        }),
      );
      await flushMicrotasks();

      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes("failed to apply synced state")),
      ).toBe(true);
      expect([...store.state.users]).toEqual([["kept", 1]]);
    } finally {
      localStorage.removeItem(key);
      warnSpy.mockRestore();
    }
  });

  it("removes the cross-tab listener when synchronous activation fails", () => {
    const key = "sync-activation-cleanup";
    const addEventListener = spyOn(window, "addEventListener");
    const removeEventListener = spyOn(window, "removeEventListener");
    try {
      localStorage.setItem(
        key,
        serializedPersistenceEnvelope({
          users: { slots: { s0: { key: "a", value: 1, extra: 2 } }, size: 1 },
        }),
      );

      expect(() =>
        createStore({ users: proxyMap<string, number>() }, { persist: { key, syncAcrossTabs: true } }),
      ).toThrow("statelift: cannot restore proxyMap from the supplied value");
      const storageRegistration = addEventListener.mock.calls.find(([type]) => type === "storage");
      if (storageRegistration === undefined) throw new Error("storage listener was not registered");
      expect(removeEventListener).toHaveBeenCalledWith("storage", storageRegistration[1]);
    } finally {
      localStorage.removeItem(key);
      addEventListener.mockRestore();
      removeEventListener.mockRestore();
    }
  });

  it("reports serialization failures as such, once, without blaming storage", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const setItem = mock((_key: string, _value: string) => {});
    try {
      const store = createStore(
        { n: 0, big: BigInt(1) },
        {
          persist: { key: "serialize-fail", storage: { getItem: () => null, setItem, removeItem: () => {} } },
        },
      );
      store.state.n = 1;
      await Promise.resolve();
      store.state.n = 2;
      await Promise.resolve();

      expect(setItem).not.toHaveBeenCalled();
      const serializeWarns = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes("failed to serialize"),
      );
      expect(serializeWarns.length).toEqual(1);
      expect(serializeWarns[0]?.[1]).toBeInstanceOf(Error);
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes("failed to persist"))).toBe(
        false,
      );

      store.state.n = 3;
      expect(store.state.n).toEqual(3);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns on dispose when the last write failed and data is unflushed", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const storage = {
      getItem: () => null,
      setItem: () => Promise.reject(new Error("write failed")),
      removeItem: () => {},
    };
    try {
      const store = createStore({ n: 0 }, { persist: { key: "unflushed-dispose", storage } });
      store.state.n = 1;

      await disposePersistence(store);

      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes("stopped with unflushed writes")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns on the last lease release when the final write failed", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const storage = {
      getItem: () => null,
      setItem: () => Promise.reject(new Error("write failed")),
      removeItem: () => {},
    };
    try {
      const store = createStore(
        { n: 0 },
        { persist: { key: "unflushed-release", storage, activation: "manual" } },
      );
      const release = activatePersistence(store);
      await persistReady(store);
      store.state.n = 1;

      release();
      await flushMicrotasks();

      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes("stopped with unflushed writes")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("persists a mid-session mutation during disposal and ignores the stale rehydrate result", async () => {
    const writes: string[] = [];
    const reads: ((value: string | null) => void)[] = [];
    let firstRead = true;
    const storage = {
      getItem: () => {
        if (firstRead) {
          firstRead = false;
          return null;
        }
        return new Promise<string | null>((resolve) => {
          reads.push(resolve);
        });
      },
      setItem: (_key: string, value: string) => {
        writes.push(value);
      },
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "rehydrate-window", storage } });
    expect(hasHydrated(store)).toBe(true);

    const hydration = rehydrate(store);
    store.state.n = 7;
    const read = reads[0];
    if (read === undefined) throw new Error("rehydrate read did not start");
    expect(await disposePersistence(store)).toEqual({ flushed: true });
    const lastWrite = writes.at(-1);
    if (lastWrite === undefined) throw new Error("disposal did not persist the mid-rehydrate write");
    expect(JSON.parse(lastWrite)).toEqual(persistenceEnvelope({ n: 7 }));

    read(serializedPersistenceEnvelope({ n: 1 }));
    await hydration;
    expect(store.state.n).toBe(7);
  });

  it("completes the lifecycle before rethrowing a malformed sync mid-session rehydrate", async () => {
    const writes: string[] = [];
    let stored: string | null = null;
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        writes.push(value);
      },
      removeItem: () => {},
    };
    const store = createStore(
      { users: proxyMap<string, number>() },
      { persist: { key: "sync-rehydrate-malformed", storage } },
    );
    expect(hasHydrated(store)).toBe(true);

    stored = serializedPersistenceEnvelope({
      users: { slots: { s0: { key: "a", value: 1, extra: 2 } }, size: 1 },
    });
    expect(() => rehydrate(store)).toThrow("statelift: cannot restore proxyMap from the supplied value");

    store.state.users.set("b", 2);
    await disposePersistence(store);
    const lastWrite = writes.at(-1);
    if (lastWrite === undefined) throw new Error("persistence stayed disabled after the failed rehydrate");
    expect(JSON.parse(lastWrite)).toEqual(
      persistenceEnvelope({ users: { slots: { s0: { key: "b", value: 2 } }, size: 1 } }),
    );
  });

  it("keeps a pending mid-rehydrate write across overlapping rehydrate calls", async () => {
    const writes: string[] = [];
    const reads: ((value: string | null) => void)[] = [];
    let firstRead = true;
    const storage = {
      getItem: () => {
        if (firstRead) {
          firstRead = false;
          return null;
        }
        return new Promise<string | null>((resolve) => {
          reads.push(resolve);
        });
      },
      setItem: (_key: string, value: string) => {
        writes.push(value);
      },
      removeItem: () => {},
    };
    const store = createStore({ n: 0 }, { persist: { key: "rehydrate-overlap", storage } });

    const stale = rehydrate(store);
    store.state.n = 7;
    const latest = rehydrate(store);
    const readB = reads[1];
    const readA = reads[0];
    if (readA === undefined || readB === undefined) throw new Error("overlapping reads did not start");
    readB(serializedPersistenceEnvelope({ n: 1 }));
    await latest;
    readA(serializedPersistenceEnvelope({ n: 2 }));
    await stale;
    await disposePersistence(store);

    expect(store.state.n).toBe(7);
    const lastWrite = writes.at(-1);
    if (lastWrite === undefined) throw new Error("the pending write was erased by the overlapping rehydrate");
    expect(JSON.parse(lastWrite)).toEqual(persistenceEnvelope({ n: 7 }));
  });
});
