/* eslint-disable @typescript-eslint/no-magic-numbers */
/* eslint-disable no-param-reassign */
import { vi } from "vitest";
import { Selector, Store, createConsumer, createStore, createUseStore, useStore } from "./store";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";

type State = {
  top: number;
  arr: number[];
  nested: {
    a: number;
    b: number;
    doubleTop: number;
    increaseTop: () => void;
  };
  doubleA: number;
  increaseNestedA: (amount?: number) => void;
  toDelete: number | undefined;
  deleteMe: () => void;
};

const createSimpleStore = () =>
  createStore<State>({
    top: 2,
    arr: [1, 2, 3],
    nested: {
      a: 3,
      b: 5,
      get doubleTop() {
        // can't reach the upper scope, only the local one with `this`
        return 0;
      },
      increaseTop() {
        // can't reach the upper scope, only the local one with `this`
      },
    },
    get doubleA() {
      return this.nested.a * 2;
    },
    increaseNestedA(amount = 1) {
      this.nested.a += amount;
    },
    toDelete: 1 as number | undefined,
    deleteMe() {
      delete this.toDelete;
    },
  });

const createSelfReferencingStoreWithRootArg = () => {
  // `root` should be infered from the return type, but we don't have that in TS yet.
  // - https://github.com/microsoft/TypeScript/issues/49618
  // - https://github.com/microsoft/TypeScript/issues/56311

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore((root: State) => ({
    top: 2,
    arr: [1, 2, 3],
    nested: {
      a: 3,
      b: 5,
      get doubleTop() {
        return root.top * 2;
      },
      increaseTop() {
        root.top = 3;
      },
    },
    get doubleA() {
      return root.nested.a * 2;
    },
    increaseNestedA(amount = 1) {
      root.nested.a += amount;
    },
    toDelete: 1 as number | undefined,
    deleteMe() {
      delete root.toDelete;
    },
  }));
};

const createSelfReferencingStoreWithStoreInstance = () => {
  const store = createStore({
    top: 2,
    arr: [1, 2, 3],
    nested: {
      a: 3,
      b: 5,
      get doubleTop() {
        return store.state.top * 2;
      },
      increaseTop() {
        store.state.top++;
      },
    },
    get doubleA() {
      return store.state.nested.a * 2;
    },
    increaseNestedA(amount = 1) {
      store.state.nested.a += amount;
    },
    toDelete: 1 as number | undefined,
    deleteMe() {
      delete store.state.toDelete;
    },
  } as State);
  return store;
};

export function useStoreWithRenderCount<T extends {}>(store: Store<T>): { count: number; state: T };
export function useStoreWithRenderCount<T extends {}, R>(
  store: Store<T>,
  selector: Selector<T, R>
): { count: number; state: R };
export function useStoreWithRenderCount<T extends {}, R>(store: Store<T>, selector?: Selector<T, R>) {
  const innerStore = useStore(store, selector!);
  const count = useRef(0);
  count.current++;
  return { count: count.current, state: innerStore };
}

describe("createStore", () => {
  it("creates a store with the given initial state", () => {
    const initialState = { foo: { bar: "baz" } };
    const store = createStore(initialState);

    expect(store.state).toEqual(initialState);
  });
});

describe("createConsumer", () => {
  it("returns a proxy that wraps the store's state", () => {
    const store = createStore({ foo: { bar: "baz" } });

    const callback = vi.fn();
    const consumer = createConsumer(store, callback);

    expect(consumer.proxy).toEqual(store.state);
  });

  it("calls the callback when the accessed data changes", () => {
    const store = createStore({ a: 1, b: 2 });

    const callback = vi.fn();
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

    const callback = vi.fn();
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

    const callback = vi.fn();
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

  it("destroys the consumer", () => {
    const store = createStore({ a: 1, b: 2 });
    const consumer = createConsumer(store, vi.fn());

    expect(consumer.proxy.a).toEqual(1);

    consumer.destroy();
    expect(() => consumer.proxy.a).toThrow(TypeError);
  });
});

const storeDefinitions = [
  { type: "simple", create: createSimpleStore },
  { type: "self-ref-root-arg", create: createSelfReferencingStoreWithRootArg },
  { type: "self-ref-store-instance", create: createSelfReferencingStoreWithStoreInstance },
];

for (const { type, create } of storeDefinitions) {
  describe(`with ${type} definition`, () => {
    describe("createStore", () => {
      it("resolves computed properties (scope)", () => {
        const store = create();

        expect(store.state.nested.a).toEqual(3);
        expect(store.state.doubleA).toEqual(6);

        store.state.nested.a = 10;
        expect(store.state.nested.a).toEqual(10);
        expect(store.state.doubleA).toEqual(20);
      });

      it("handles state actions (scope)", () => {
        const store = create();

        expect(store.state.nested.a).toEqual(3);

        store.state.increaseNestedA();
        expect(store.state.nested.a).toEqual(4);
      });

      it("handles deletions (scope)", () => {
        const store = create();

        expect(store.state.toDelete).toEqual(1);

        delete store.state.toDelete;
        expect(store.state.toDelete).toEqual(undefined);
      });

      if (type !== "simple") {
        it("resolves computed properties (root)", () => {
          const store = create();

          expect(store.state.nested.doubleTop).toEqual(4);
          store.state.top = 10;
          expect(store.state.nested.doubleTop).toEqual(20);
        });

        it("processes actions (root)", () => {
          const store = create();

          expect(store.state.top).toEqual(2);

          store.state.nested.increaseTop();
          expect(store.state.top).toEqual(3);
        });
      }
    });

    describe("useStore", () => {
      it("returns the current state of the store", () => {
        const store = create();

        const { result } = renderHook(() => useStore(store));

        expect(result.current).toEqual(store.state);
      });

      it("rerenders when accessed data changes", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        const initialNestedObject = result.current.state.nested;

        // access store.nested.a
        expect(result.current.state.nested.a).toEqual(3);
        expect(result.current.count).toEqual(1);
        expect(result.current.state.nested).toBe(initialNestedObject);

        // mutate store.nested.a
        act(() => {
          store.state.nested.a = 100;
        });
        expect(result.current.state.nested.a).toEqual(100);
        expect(result.current.count).toEqual(2);
        expect(result.current.state.nested).not.toBe(initialNestedObject);
      });

      it("does not rerender when data that was not accessed changes", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        // access store.nested.a
        expect(result.current.state.nested.a).toEqual(3);
        expect(result.current.count).toEqual(1);

        // mutate store.nested.b
        act(() => {
          store.state.nested.b = 100;
        });
        expect(result.current.count).toEqual(1);
      });

      it("rerenders when accessed data is deleted", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        // access store.arr
        expect(result.current.state.toDelete).toEqual(1);
        expect(result.current.count).toEqual(1);

        // delete item
        act(() => {
          delete store.state.toDelete;
        });
        expect(result.current.state.toDelete).toEqual(undefined);
        expect(result.current.count).toEqual(2);
      });

      it("does not rerender when data that was not accessed is deleted", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        // access store.arr
        expect(result.current.state.top).toEqual(2);
        expect(result.current.count).toEqual(1);

        // delete item
        act(() => {
          delete store.state.toDelete;
        });
        expect(result.current.count).toEqual(1);
      });

      it("rerenders when accessed computed data's dependencies change", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        // access store.doubleA
        expect(result.current.state.doubleA).toEqual(6);
        expect(result.current.count).toEqual(1);

        // mutate store.nested.a
        act(() => {
          store.state.nested.a = 100;
        });
        expect(result.current.state.doubleA).toEqual(200);
        expect(result.current.count).toEqual(2);
      });

      it("does rerender a list consumer when items are added / removed", () => {
        const store = createStore({ items: [{ value: 1 }, { value: 2 }] });
        const { result } = renderHook(() => useStoreWithRenderCount(store));

        // access store.items
        expect(result.current.state.items.length).toEqual(2);
        expect(result.current.count).toEqual(1);

        // rerender when an item is added
        act(() => {
          store.state.items.push({ value: 3 });
        });
        expect(result.current.count).toEqual(2);

        // rerender when an item is removed
        act(() => {
          store.state.items.pop();
        });
        expect(result.current.count).toEqual(3);
      });

      it("does not rerender a list consumer when an unwatched property of an item is changed", () => {
        const state = {
          items: Array.from({ length: 5 }, (_, i) => ({ id: i, value: i })),
        };
        const store = createStore(state);
        const { result } = renderHook(() => useStoreWithRenderCount(store));

        // access store.items and store.items[index].id
        expect(result.current.state.items.length).toEqual(5);
        for (let i = 0; i < 5; i++) {
          expect(result.current.state.items[i].id).toEqual(i);
        }
        expect(result.current.count).toEqual(1);

        // mutate store.items[index].value (unwatched)
        act(() => {
          store.state.items[0].value += 1;
        });
        expect(result.current.count).toEqual(1);

        // mutate store.items[index].id (watched)
        act(() => {
          store.state.items[0].id += 1;
        });
        expect(result.current.count).toEqual(2);
      });

      it("supports custom selector", () => {
        const store = create();

        const { result } = renderHook(() =>
          useStore(store, (state) => ({
            a: state.nested.a,
            b: state.nested.b,
            sum: state.nested.a + state.nested.b,
          }))
        );

        expect(result.current).toEqual({ a: 3, b: 5, sum: 8 });
      });

      it("doesn't rerender when accessed data changes but the selector returns the same value", () => {
        const store = create();

        const { result } = renderHook(() =>
          useStoreWithRenderCount(store, (state) => state.nested.a + state.nested.b)
        );

        expect(result.current.state).toEqual(8);
        expect(result.current.count).toEqual(1);

        act(() => {
          store.state.nested.a = 10;
        });

        expect(result.current.state).toEqual(15);
        expect(result.current.count).toEqual(2);

        act(() => {
          store.state.nested.a = 10;
        });

        expect(result.current.state).toEqual(15);
        expect(result.current.count).toEqual(2);
      });
    });
  });
}

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

    // keys didn't change, so no rerender
    expect(result.current.count).toEqual(1);
  });

  it("rerenders when for...in loop is used and new property is added", () => {
    const store = createStore<{ data: Record<string, string> }>({ data: { x: "1" } });

    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (state) => {
        const keys: string[] = [];
        for (const key in state.data) {
          keys.push(key);
        }
        return keys;
      })
    );

    expect(result.current.state).toEqual(["x"]);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.data.y = "2";
    });

    expect(result.current.state).toEqual(["x", "y"]);
    expect(result.current.count).toEqual(2);
  });

  it("rerenders when spread operator is used and new property is added", () => {
    const store = createStore<{ config: Record<string, boolean> }>({ config: { enabled: true } });

    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (state) => ({ ...state.config }))
    );

    expect(result.current.state).toEqual({ enabled: true });
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.config.debug = false;
    });

    expect(result.current.state).toEqual({ enabled: true, debug: false });
    expect(result.current.count).toEqual(2);
  });

  it("does not affect consumers that don't enumerate keys", () => {
    const store = createStore<{ items: Record<string, number> }>({ items: { a: 1, b: 2 } });

    // consumer only accesses specific property, not keys
    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => state.items.a));

    expect(result.current.state).toEqual(1);
    expect(result.current.count).toEqual(1);

    // add new property - should not trigger rerender for this consumer
    act(() => {
      store.state.items.c = 3;
    });

    expect(result.current.count).toEqual(1);

    // change watched property - should trigger rerender
    act(() => {
      store.state.items.a = 100;
    });

    expect(result.current.state).toEqual(100);
    expect(result.current.count).toEqual(2);
  });
});

describe("array length truncation notifications", () => {
  it("rerenders consumer watching specific index when that index is removed via length truncation", () => {
    const store = createStore({ arr: [10, 20, 30, 40, 50] });

    // consumer watches index 3
    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr[3]));

    expect(result.current.state).toEqual(40);
    expect(result.current.count).toEqual(1);

    // truncate array to remove index 3
    act(() => {
      store.state.arr.length = 2;
    });

    expect(result.current.state).toEqual(undefined);
    expect(result.current.count).toEqual(2);
  });

  it("does not rerender consumer watching index that survives truncation", () => {
    const store = createStore({ arr: [10, 20, 30, 40, 50] });

    // consumer watches index 1
    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr[1]));

    expect(result.current.state).toEqual(20);
    expect(result.current.count).toEqual(1);

    // truncate array but keep index 1
    act(() => {
      store.state.arr.length = 3;
    });

    // index 1 still exists, no rerender needed for this consumer
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

    // consumer watches index 5 (doesn't exist yet)
    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr[5]));

    expect(result.current.state).toEqual(undefined);
    expect(result.current.count).toEqual(1);

    // expand array
    act(() => {
      store.state.arr.length = 10;
    });

    // length expansion doesn't trigger truncation notifications
    expect(result.current.count).toEqual(1);
  });

  it("rerenders multiple consumers watching different removed indices", () => {
    const store = createStore({ arr: [10, 20, 30, 40, 50] });

    // consumer 1 watches index 2
    const { result: result1 } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr[2]));
    // consumer 2 watches index 4
    const { result: result2 } = renderHook(() => useStoreWithRenderCount(store, (state) => state.arr[4]));

    expect(result1.current.state).toEqual(30);
    expect(result2.current.state).toEqual(50);
    expect(result1.current.count).toEqual(1);
    expect(result2.current.count).toEqual(1);

    // truncate to length 2, removing indices 2, 3, 4
    act(() => {
      store.state.arr.length = 2;
    });

    expect(result1.current.state).toEqual(undefined);
    expect(result2.current.state).toEqual(undefined);
    expect(result1.current.count).toEqual(2);
    expect(result2.current.count).toEqual(2);
  });

  it("rerenders ownKeys consumer when array is truncated via pop()", () => {
    const store = createStore({ arr: [1, 2, 3] });

    const { result } = renderHook(() => useStoreWithRenderCount(store, (state) => Object.keys(state.arr)));

    expect(result.current.state).toEqual(["0", "1", "2"]);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.arr.pop();
    });

    expect(result.current.state).toEqual(["0", "1"]);
    expect(result.current.count).toEqual(2);
  });
});

describe("'in' operator dependency tracking", () => {
  it("rerenders when using 'in' operator and property is added", () => {
    const store = createStore<{ data: Record<string, number> }>({ data: { a: 1 } });

    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (state) => "b" in state.data)
    );

    expect(result.current.state).toEqual(false);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.data.b = 2;
    });

    expect(result.current.state).toEqual(true);
    expect(result.current.count).toEqual(2);
  });

  it("rerenders when using 'in' operator and property is deleted", () => {
    const store = createStore<{ data: Record<string, number | undefined> }>({ data: { a: 1, b: 2 } });

    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (state) => "b" in state.data)
    );

    expect(result.current.state).toEqual(true);
    expect(result.current.count).toEqual(1);

    act(() => {
      delete store.state.data.b;
    });

    expect(result.current.state).toEqual(false);
    expect(result.current.count).toEqual(2);
  });

  it("does not rerender when unrelated property changes", () => {
    const store = createStore<{ data: Record<string, number> }>({ data: { a: 1, b: 2 } });

    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (state) => "a" in state.data)
    );

    expect(result.current.state).toEqual(true);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.data.b = 999;
    });

    expect(result.current.count).toEqual(1);
  });
});

describe("strict mode", () => {
  it("throws when accessing built-in objects in strict mode", () => {
    const store = createStore({ date: new Date() }, { strict: true });

    expect(() => store.state.date).toThrow(/Built-in object "Date" detected/);
  });

  it("throws for Map in strict mode", () => {
    const store = createStore({ map: new Map() }, { strict: true });

    expect(() => store.state.map).toThrow(/Built-in object "Map" detected/);
  });

  it("does not throw without strict mode", () => {
    const store = createStore({
      date: new Date(),
      map: new Map(),
      set: new Set(),
    });

    expect(() => store.state.date.getTime()).not.toThrow();
    expect(() => store.state.map.get("test")).not.toThrow();
    expect(() => store.state.set.has(1)).not.toThrow();
  });

  it("built-in object replacement still triggers rerenders", () => {
    const store = createStore<{ date: Date }>({ date: new Date("2024-01-01") });

    const { result } = renderHook(() =>
      useStoreWithRenderCount(store, (state) => state.date)
    );

    expect(result.current.count).toEqual(1);
    const oldDate = result.current.state;

    act(() => {
      store.state.date = new Date("2024-12-31");
    });

    expect(result.current.count).toEqual(2);
    expect(result.current.state).not.toBe(oldDate);
  });
});

describe("createUseStore", () => {
  it("returns full state when called without selector", () => {
    const store = createStore({ count: 0, name: "test" });
    const useTestStore = createUseStore(store);

    const { result } = renderHook(() => useTestStore());

    expect(result.current).toEqual({ count: 0, name: "test" });
  });

  it("returns selected value when called with selector", () => {
    const store = createStore({ count: 42, name: "test" });
    const useTestStore = createUseStore(store);

    const { result } = renderHook(() => useTestStore((s) => s.count));

    expect(result.current).toEqual(42);
  });

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
