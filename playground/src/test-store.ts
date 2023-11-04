/* eslint-disable no-param-reassign */
import { createStore } from "reactlift";

export const testStore = createStore(
  { nested: { a: 0, b: 0 } },
  {
    computed: {
      doubleA: (state) => state.nested.a * 2,
      doubleB: (state) => state.nested.b * 2,
    },
    actions: {
      incrementA: ({ state }, step: number) => {
        state.nested.a += step;
      },
      incrementB: ({ state }, step: number) => {
        state.nested.b += step;
      },
    },
  }
);
