/* eslint-disable no-param-reassign */
import { createStore } from "reactlift";

const createSimpleStore = () =>
  createStore({
    top: 10,
    nested: {
      a: 0,
      b: 0,
      get c() {
        return this.b;
      },
    },
    get doubleA() {
      return this.nested.a * 2;
    },
    incrementA(amount = 10) {
      this.nested.a += amount;
    },
    incrementB(amount = 10) {
      this.nested.b += amount;
    },
  });

const createSelfReferencingStoreWithRootArg = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createStore((root: any) => ({
    top: 10,
    nested: {
      a: 0,
      b: 0,
      get c() {
        return this.b;
      },
    },
    get doubleA() {
      return this.nested.a * 2;
    },
    incrementA(amount = 10) {
      console.log({ root, this: this });
      root.nested.a += amount;
    },
    incrementB(amount = 10) {
      root.nested.b += amount;
    },
  }));

const createSelfReferencingStoreWithStoreInstance = () => {
  type Store = {
    top: number;
    nested: {
      a: number;
      b: number;
      c: number;
    };
    doubleA: number;
    incrementA: (amount?: number) => void;
    incrementB: (amount?: number) => void;
  };
  const store = createStore({
    top: 10,
    nested: {
      a: 0,
      b: 0,
      get c() {
        return store.state.nested.b;
      },
    },
    get doubleA() {
      return store.state.nested.a * 2;
    },
    incrementA(amount = 10) {
      store.state.nested.a += amount;
    },
    incrementB(amount = 10) {
      store.state.nested.b += amount;
    },
  } as Store);
  return store;
};

export const simpleStore = createSimpleStore();
export const selfReferencingStoreWithRootArg = createSelfReferencingStoreWithRootArg();
export const selfReferencingStoreWithStoreInstance = createSelfReferencingStoreWithStoreInstance();

export type Store =
  typeof selfReferencingStoreWithRootArg | typeof selfReferencingStoreWithStoreInstance | typeof simpleStore;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).stores = {
  simpleStore,
  selfReferencingStoreWithRootArg,
  selfReferencingStoreWithStoreInstance,
};
