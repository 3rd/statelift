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
    // "this" is "store" here, because we're at the root
    return this.nested.a + this.nested.b;
  },
  increaseA(amount: number) {
    this.nested.a += amount;
  },
  yummy: {
    get doubleA() {
      // "this" can't work here
      return store.nested.a * 2;
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

### Benchmarks
