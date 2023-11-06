/* eslint-disable no-param-reassign */
import { createStore } from "reactlift";

export const createSimpleStore = () =>
  createStore({
    top: 10,
    nested: {
      a: 1,
      b: 1,
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

export const createSelfReferencingStoreWithRootArg = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createStore((root: any) => ({
    top: 10,
    nested: {
      a: 1,
      b: 1,
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

export const createSelfReferencingStoreWithStoreInstance = () => {
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
      a: 1,
      b: 1,
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
