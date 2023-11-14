/* eslint-disable @typescript-eslint/no-magic-numbers */
/* eslint-disable no-param-reassign */
import { vi } from "vitest";
import { Selector, Store, createConsumer, createStore, useStore } from "./store";
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
export function useStoreWithRenderCount<T extends {}, R>(
  store: Store<T>,
  selector?: Selector<T, R>
) {
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

        // access store.nested.a
        expect(result.current.state.nested.a).toEqual(3);
        expect(result.current.count).toEqual(1);

        // mutate store.nested.a
        act(() => {
          store.state.nested.a = 100;
        });
        expect(result.current.state.nested.a).toEqual(100);
        expect(result.current.count).toEqual(2);
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
