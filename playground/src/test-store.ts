import { createStore } from "reactlift";

export const testStore = createStore({
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
