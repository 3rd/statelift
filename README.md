# Statelift

**Statelift** is a proxy-based state management library for React.
\
Its main purpose is to offer the simplest way of creating and using state containers.

> [!IMPORTANT]  
> Statelift is in a working but experimental state, proceed at your own peril.
> \
> Don't put weird things in your store.

**What it offers:**

- The simplest API
- Decent performance (benchmarks below)
- Selectors
- TypeScript all the way

**How it looks:**

```tsx
import { createStore, useStore } from "statelift";

// This is just one of the signatures of createStore(), it can also just take an object,
// or reference the store const directly, instead of the argument.
const store = createStore((root) => ({
  foo: {
    bar: 10,
    baz: 5,
  },
  get doubleBar() {
    return root.foo.bar * 2;
  },
  increaseBar() {
    root.foo.bar += 10;
  },
}));

// Bar only consumes store.doubleBar, and will rerender only when its dependencies change.
const Bar = () => {
  const state = useStore(store);

  return (
    <>
      <p>Double bar: {state.doubleBar}</p>
      <button onClick={() => state.foo.bar++}>Increase directly</button>
      <button onClick={state.increaseBar}>Increase through action</button>
    </>
  );
};

// Same for Baz, it won't rerender when anything except foo.baz changes.
const Baz = () => {
  const state = useStore(store);

  return <p>Baz: {state.foo.baz}</p>;
};

// You can interact with the store from anywhere you like, and it will work as you expect.
store.state.foo.bar = 100;
```

---

### Usage

#### Installation

:point_right: [statelift on NPM](http://npmjs.com/package/statelift)
\
`pnpm add statelift`

#### Creating a store

The `createStore()` function takes either a plain object, or a builder function.

If you want to have getters (computed values) or functions that modify the state (actions) that live on
branches that are unreacheable from their local scope, you can refer to the root using either the **store variable
itself**, or the **root argument** provided to the builder function.

**Creating a store from an object**

You can always read and mutate data that is reacheable the local scope using `this`, it works as expected.
\
Chances are that this won't be very comfy, so using the builder function is probably what you want.

```ts
const store = createStore({
  nested: {
    a: 10,
    b: 5,
  },
  get sum() {
    // "this" is "store.state" here, because we're at the root
    return this.nested.a + this.nested.b;
  },
  increaseA(amount: number) {
    this.nested.a += amount;
  },
  yummy: {
    get doubleA() {
      // "this" can't work here
      return store.state.nested.a * 2;
    },
  },
});
```

**Creating a store from a builder function**

Your builder function is called with a reference to the root state.
\
Basically `root` is `store.state`, and also `this` at the top level of the object you're returning.
\
And yes, you're writing a function that takes its own return value as its argument.

```ts
const store = createStore((root) => ({
  nested: {
    a: 10,
    b: 5,
  },
  get sum() {
    return root.nested.a + root.nested.b;
  },
  increaseA(amount: number) {
    root.nested.a += amount;
  },
  yummy: {
    get doubleA() {
      return root.nested.a * 2;
    },
  },
}));
```

#### Using a store

All you have to do to use your store in a React component is to pass it to the `useStore()` hook.

```tsx
const counterStore = createStore({
  value: 0,
  increment() {
    this.value++;
  },
});

const Component = () => {
  const counter = useStore(counterStore);

  return (
    <>
      <p>Count: {counter.value}</p>
      <button onClick={() => counter.value++}>Increase (direct)</button>
      <button onClick={counter.increment}>Increase (action)</button>
    </>
  );
};
```

**Selectors**

Sometimes we need selectors to avoid rerendering a component depending on some per-item condition.

For example when having a list of items, of which one can be selected.
\
Without a selector, all the item components will be subscribed to the currently selected item identifier, and
when that one changes, we'd rerender everything.

To avoid that, we can use a selector that runs at store level, and the component will only update when the
computed value changes.

```tsx
type Item = { id: string; label: string };

type Store = {
  selectedId: string | null;
  items: Item[];
};

const store = createStore<Store>({
  selectedId: null,
  items: [
    /* ...many items */
  ],
});

const ListItem = (item: Item) => {
  const isSelected = useStore(store, (state) => state.selectedId === item.id);

  return (
    <li>
      {isSelected && <strong>*</strong>}
      {item.label}
    </li>
  );
};

const List = (items: Item[]) => {
  const state = useStore(store);

  return (
    <ul>
      {state.items.map((item) => (
        <ListItem key={item.id} item={item} />
      ))}
    </ul>
  );
};
```

**Batching**

When you need to make multiple state updates that should trigger only a single re-render, use the `batch()` function:

```ts
import { createStore, batch } from "statelift";

const store = createStore({
  a: 0,
  b: 0,
  c: 0,
});

// without batch: each assignment triggers a separate re-render
store.state.a = 1;
store.state.b = 2;
store.state.c = 3;

// with batch: all assignments trigger a single re-render
batch(store, () => {
  store.state.a = 1;
  store.state.b = 2;
  store.state.c = 3;
});
```

**Strict Mode**

Built-in objects like `Map`, `Set`, `Date`, and `RegExp` cannot be made reactive due to JavaScript proxy limitations.\
By default, statelift returns them as-is without proxying, which means changes to them won't trigger re-renders.

If you want to catch accidental usage of non-reactive objects, enable strict mode:

```ts
const store = createStore(
  { createdAt: new Date() },
  { strict: true }
);
// throws: built-in objects cannot be made reactive
```

**Creating bound hooks with createUseStore**

For cleaner imports and better ergonomics, you can create a pre-bound hook for your store using `createUseStore()`:

```tsx
// stores/cart.ts
import { createStore, createUseStore } from "statelift";

type CartItem = { id: string; name: string; quantity: number };

const cartStore = createStore({
  items: [] as CartItem[],
  addItem(item: CartItem) {
    this.items.push(item);
  },
  get total() {
    return this.items.reduce((sum, item) => sum + item.quantity, 0);
  },
});

export const useCartStore = createUseStore(cartStore);

// components/CartBadge.tsx
import { useCartStore } from "../stores/cart";

const CartBadge = () => {
  const total = useCartStore((s) => s.total);
  return <span>{total} items</span>;
};

// components/CartList.tsx
const CartList = () => {
  const cart = useCartStore();
  return (
    <ul>
      {cart.items.map((item) => (
        <li key={item.id}>{item.name} x{item.quantity}</li>
      ))}
    </ul>
  );
};
```

### Benchmarks

![image](https://github.com/3rd/statelift/assets/59587503/eb09b938-3bfe-4283-8f46-ac14dd572da8)
