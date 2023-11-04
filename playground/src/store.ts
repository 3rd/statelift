/* eslint-disable no-param-reassign */
import { createStore } from "reactlift";

const config = {
  dynamic: true,
};

const createStaticStore = () =>
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

const createDynamicStore = () =>
  createStore((root) => ({
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

export const store = config.dynamic ? createDynamicStore() : createStaticStore();
(window as any).store = store;
