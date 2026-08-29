# Statelift

Statelift is an experimental proxy-based state management library for React and plain
JavaScript. A store exposes mutable state while Statelift tracks reads and
updates only the consumers affected by a change.

Statelift provides:

- Fine-grained React updates through access tracking and selectors
- Cached getters and derived stores with `computed()`
- Subscriptions outside React and explicit batching
- Snapshots, restore, persistence, SSR hydration, and graph transport
- Reactive collections with `Map` and `Set` method shapes
- Redux DevTools integration
- A React-free `statelift/vanilla` module

## Installation

Statelift is available on [npm](https://www.npmjs.com/package/statelift):

```sh
npm install statelift
```

The main `statelift` module exports the store APIs and React hooks. Applications
that import it must provide React 18 or 19; `react-dom` is not required.

For server-side use, Statelift requires Node.js 22 or newer or Bun 1.1 or newer.

Node services, workers, CLIs, and non-React frontends can import the same store
APIs from `statelift/vanilla`, which does not import React:

```ts
import { computed, createStore, subscribe } from "statelift/vanilla";
```

Redux DevTools support is a separate `statelift/devtools` module.

## Quick start

```tsx
import { createStore, useStore } from "statelift";

type CounterState = {
  count: number;
  readonly doubled: number;
  increment(): void;
};

const counterStore = createStore<CounterState>((state) => ({
  count: 0,
  get doubled() {
    return state.count * 2;
  },
  increment() {
    state.count += 1;
  },
}));

export const Counter = () => {
  const counter = useStore(counterStore);

  return (
    <>
      <p>
        Count: {counter.count}; doubled: {counter.doubled}
      </p>
      <button onClick={() => counter.count += 1}>Increase directly</button>
      <button onClick={counter.increment}>Increase with an action</button>
    </>
  );
};
```

`useStore(counterStore)` returns a reactive proxy. `Counter` reads `count` and
`doubled`, so changes to unrelated store properties do not re-render it. Store
state is also available outside React through `counterStore.state`.

## Creating stores

`createStore()` accepts a plain object or a builder function. The store root must
be a plain record. It can contain arrays, reactive collections, and other
supported values, but those values cannot be the root.

### Object form

Use `this` when a getter or action only needs data from its own object:

```ts
import { createStore } from "statelift";

const temperatureStore = createStore({
  celsius: 20,
  get fahrenheit() {
    return this.celsius * 9 / 5 + 32;
  },
  setCelsius(celsius: number) {
    this.celsius = celsius;
  },
});

temperatureStore.state.setCelsius(25);
console.log(temperatureStore.state.fahrenheit);
```

Inside a nested object, `this` refers to that nested object. Use the builder form
when nested getters or actions need the root state.

### Builder form

The builder receives the root state exposed as `store.state`:

```ts
import { createStore } from "statelift";

type CartItem = { id: string; quantity: number };

type CartState = {
  items: CartItem[];
  summary: { readonly itemCount: number };
  addItem(item: CartItem): void;
};

const cartStore = createStore<CartState>((state) => ({
  items: [],
  summary: {
    get itemCount() {
      return state.items.reduce((count, item) => count + item.quantity, 0);
    },
  },
  addItem(item) {
    state.items.push(item);
  },
}));

cartStore.state.addItem({ id: "book", quantity: 2 });
console.log(cartStore.state.summary.itemCount);
```

## Derived state

### Computed getters

Getter-only properties are cached. A getter evaluates on its first read and
evaluates again only after one of the store values it read changes. The cache is
shared by every component and subscriber that reads that getter.

Use `uncached()` only for a getter that depends on data outside the store, such as
the current time or randomness. It marks the getter so Statelift evaluates it on
every read. This JavaScript example defines the getter before creating the store:

```js
import { createStore, uncached } from "statelift";

const startedAt = Date.now();
const timerState = {};

Object.defineProperty(timerState, "elapsedMs", {
  enumerable: true,
  get: uncached(() => Date.now() - startedAt),
});

const timerStore = createStore(timerState);
console.log(timerStore.state.elapsedMs);
```

### Computed stores with `computed()`

`computed()` creates a read-only store whose result is available at
`derivedStore.state.value`. It tracks the source reads made by the derivation and
updates only when the result changes according to `Object.is`.

```tsx
import { computed, createStore, subscribe, useStore } from "statelift";

type LineItem = { price: number; quantity: number };

type CartState = { items: LineItem[] };

const cartStore = createStore<CartState>({
  items: [{ price: 12, quantity: 2 }],
});

const totalStore = computed(cartStore, (cart) =>
  cart.items.reduce((total, item) => total + item.price * item.quantity, 0));

const stopLogging = subscribe(
  totalStore,
  (state) => state.value,
  (total, previousTotal) => {
    console.log(`Total changed from ${previousTotal} to ${total}`);
  },
);

export const CartTotal = () => {
  const total = useStore(totalStore, (state) => state.value);
  return <p>Total: ${total}</p>;
};

cartStore.state.items.push({ price: 8, quantity: 1 });
stopLogging();
```

Pass a record of source stores as the first argument when one derived value
depends on several stores.

## React selectors

The second argument to `useStore()` is a selector. Statelift passes the current
store state to it, and the component re-renders only when the selected result
changes.

```tsx
import { createStore, useStore } from "statelift";

type Item = { id: string; label: string };

type SelectionState = { selectedId: string | null };

const selectionStore = createStore<SelectionState>({
  selectedId: null,
});

export const ListItem = ({ item }: { item: Item }) => {
  const isSelected = useStore(
    selectionStore,
    (state) => state.selectedId === item.id,
  );

  return <li>{isSelected ? `✓ ${item.label}` : item.label}</li>;
};
```

`useStore(store)` tracks direct property reads through its returned proxy. Use a
selector when the component needs a derived result, such as the per-item
condition above.

Selectors use `Object.is` by default. If a selector creates a new object or array,
pass `shallow` to keep the previous result reference when its top-level values
are equal:

```tsx
import { createStore, shallow, useStore } from "statelift";

type CartItem = { price: number; quantity: number };

type CartState = { items: CartItem[] };

const cartStore = createStore<CartState>({
  items: [],
});

export const CartSummary = () => {
  const summary = useStore(
    cartStore,
    (state) => ({
      itemCount: state.items.length,
      total: state.items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0,
      ),
    }),
    { equalityFn: shallow },
  );

  return <p>{summary.itemCount} items, ${summary.total}</p>;
};
```

## Batching

`batch()` groups several mutations into one Statelift update and returns the
callback's result. If the callback throws, Statelift closes the batch before
the error propagates.

```ts
import { batch, createStore } from "statelift";

const positionStore = createStore({ x: 0, y: 0 });

batch(positionStore, () => {
  positionStore.state.x = 120;
  positionStore.state.y = 80;
});
```

## Store subscriptions

`subscribe()` observes a store without a React component and returns an
unsubscribe function. Its selector receives the current store state. Its
callback receives the new selected value followed by the previous selected
value.

```ts
import { createStore, subscribe } from "statelift";

const viewportStore = createStore({ scrollY: 0 });

const stopScrollSubscription = subscribe(
  viewportStore,
  (state) => state.scrollY,
  (scrollY, previousScrollY) => {
    console.log(`Scroll position changed from ${previousScrollY} to ${scrollY}`);
  },
);

viewportStore.state.scrollY = 120;
stopScrollSubscription();
```

`subscribe(store, callback)` runs after any effective store change. A typed
dotted path is shorthand for the selector form:

```ts
import { createStore, subscribe } from "statelift";

const accountStore = createStore({
  user: { name: "Ada" },
});

const stopAnyChange = subscribe(accountStore, () => {
  console.log("Account store changed");
});

const stopNameChange = subscribe(
  accountStore,
  "user.name",
  (name, previousName) => {
    console.log(`Name changed from ${previousName} to ${name}`);
  },
);

accountStore.state.user.name = "Grace";
stopAnyChange();
stopNameChange();
```

Pass `{ fireImmediately: true }` to run once at subscription time. Selector
subscriptions also accept an `equalityFn` option.

## Snapshots and restore

`snapshot()` returns a cached, proxy-free, read-only view of the complete store.
It removes actions and materializes computed getters as data. Repeated calls
return the same object until the store changes.

`restore()` replaces the store's data with a full snapshot while preserving its
actions and computed getters:

```ts
import { createStore, restore, snapshot } from "statelift";

const editorStore = createStore({
  title: "Draft",
  revision: 1,
});

const checkpoint = snapshot(editorStore);

editorStore.state.title = "Unwanted edit";
editorStore.state.revision += 1;

restore(editorStore, checkpoint);
console.log(editorStore.state.title);
```

Native built-ins such as `Date`, `Map`, and `Set` remain shared by reference in a
snapshot. Reactive `proxyMap()` and `proxySet()` values become read-only native
copies.

## Moving state across boundaries

Use Statelift proxies directly in React components, selectors, subscriptions,
and store updates. Convert them when another API rejects proxies or requires an
independent copy:

- Use `snapshot(store)` for a read-only, proxy-free view of the complete store.
- Use `structuredClone(snapshot(store))` for an independent graph when every
  value supports structured cloning.
- Use `unwrapDeepProxy(value)` for a mutable copy of one plain object or
  array subtree.
- Use `dehydrate(store)` and `hydrate(store, payload)` to encode a complete
  Statelift graph for JSON, React Server Components, or network transport.

This example modifies a detached list, then assigns it back to the store:

```ts
import { createStore, unwrapDeepProxy } from "statelift";

type Todo = { id: string; title: string };

type TodoState = { todos: Todo[] };

const todoStore = createStore<TodoState>({
  todos: [{ id: "first", title: "Read the README" }],
});

const editableTodos = unwrapDeepProxy(todoStore.state.todos);
editableTodos.push({ id: "second", title: "Build the app" });

todoStore.state.todos = editableTodos;
```

`unwrapProxy()` returns the original raw target without copying it. Reads and
writes through that target bypass tracking and notifications, so update state
through the store proxy instead.

### Graph transport

`dehydrate()` returns an opaque, versioned payload. `hydrate()` decodes and
merges it through the store's mutation path:

```ts
import { createStore, dehydrate, hydrate } from "statelift";

type SessionState = {
  userId: string | null;
  featureFlags: string[];
};

const serverSessionStore = createStore<SessionState>({
  userId: "user-123",
  featureFlags: ["new-navigation"],
});

const payload = dehydrate(serverSessionStore);

const clientSessionStore = createStore<SessionState>({
  userId: null,
  featureFlags: [],
});

hydrate(clientSessionStore, payload);
```

The transport preserves cycles, aliases, sparse arrays, supported built-ins,
symbols, and native or reactive collections. It rejects functions, local
symbols, unsupported class instances, and other values it cannot reproduce. For
untrusted data, pass a `validate` function to `hydrate()`; validation completes
before the store is mutated.

## Reactive collections

Native `Map` and `Set` instances are not reactive. Use `proxyMap()` and
`proxySet()` when collection mutations must notify consumers:

```ts
import { createStore, proxyMap, proxySet } from "statelift";

type User = { name: string };

const directoryStore = createStore({
  users: proxyMap<string, User>(),
  selectedUserIds: proxySet<string>(),
});

directoryStore.state.users.set("ada", { name: "Ada Lovelace" });
directoryStore.state.selectedUserIds.add("ada");
```

`proxyMap()` and `proxySet()` follow the `Map` and `Set` method shapes but are not
native instances, so `instanceof Map` and `instanceof Set` return `false`.
Iteration uses a snapshot taken when iteration starts. Wrap multi-step
collection changes in `batch()` when they should produce one update.

## Strict mode and frozen data

You can store native built-ins such as `Date`, `RegExp`, `Map`, and `Set`.
Statelift returns them unchanged by default, so mutations inside them do not
notify consumers. Replacing a store property that contains a built-in still
notifies consumers. Set `{ strict: true }` in `createStore()` to throw when code
reads a built-in through the store. Use `proxyMap()` or `proxySet()` for reactive
collections.

Frozen objects and non-writable, non-configurable properties also pass through
without tracking. Replacing the reactive property that holds a frozen object
still notifies consumers.

## React helpers

### Bound store hooks

`createUseStore()` creates a hook bound to one store:

```tsx
import { createStore, createUseStore } from "statelift";

type CartItem = { id: string; quantity: number };

type CartState = {
  items: CartItem[];
  readonly itemCount: number;
};

const cartStore = createStore<CartState>((state) => ({
  items: [],
  get itemCount() {
    return state.items.reduce((count, item) => count + item.quantity, 0);
  },
}));

const useCartStore = createUseStore(cartStore);

export const CartBadge = () => {
  const itemCount = useCartStore((state) => state.itemCount);
  return <span>{itemCount} items</span>;
};
```

### Local component state

`useProxyState()` creates mutable proxy state owned by one component. Its proxy
identity is stable, and any mutation re-renders the component. Unlike
`useStore()`, it does not track individual property reads.

```tsx
import { useProxyState } from "statelift";

type FormState = { name: string; tags: string[] };

export const ProfileForm = () => {
  const form = useProxyState<FormState>({ name: "", tags: [] });

  return (
    <>
      <input
        value={form.name}
        onChange={(event) => {
          form.name = event.target.value;
        }}
      />
      <button onClick={() => form.tags.push("new")}>Add tag</button>
    </>
  );
};
```

Getter-only accessors in `useProxyState()` are cached until the next mutation.
`uncached()` opts a getter out of that cache.

## Persistence

In a browser, a string `persist` option uses `localStorage` under that key:

```ts
import { createStore } from "statelift";

const preferencesStore = createStore(
  { theme: "dark", fontSize: 14 },
  { persist: "user-preferences" },
);

preferencesStore.state.theme = "light";
```

Persistence snapshots omit functions and materialize getter values as data.
During hydration, stored data merges into the initial state; getter-only keys are
skipped and recomputed from the restored data. Writes use a microtask debounce
by default.

Use the object form to configure persistence:

- `storage` accepts synchronous or asynchronous `getItem`, `setItem`, and
  `removeItem` methods.
- `version` writes a schema version with the payload, and `migrate` converts data
  from older versions.
- `partialize` chooses which snapshot fields to store.
- `serializer` replaces the default JSON codec.
- `skipHydration` defers the read until `rehydrate(store)`.
- `throttle` limits write frequency.
- `syncAcrossTabs` listens for changes from the built-in `localStorage` adapter.
- `activation: "manual"` defers persistence I/O until
  `activatePersistence(store)` acquires a lifecycle lease.

Use `hasHydrated(store)` for a synchronous status check or
`await persistReady(store)` to wait for an asynchronous adapter. Release a
manual activation lease when its owner unmounts. Use
`disposePersistence(store)` only for permanent shutdown.

## SSR and hydration

Create stores per request on the server. `createStoreContext()` packages a store
factory, provider, and bound hooks so each provider mount owns a fresh store:

```tsx
import { createStore, createStoreContext } from "statelift";

type AppState = {
  user: { name: string } | null;
};

const appStore = createStoreContext<AppState>(() =>
  createStore<AppState>({ user: null }),
);

const UserName = () => {
  const user = appStore.useStore((state) => state.user);
  return <span>{user?.name ?? "Guest"}</span>;
};

export const App = ({ initialState }: { initialState: AppState }) => (
  <appStore.Provider data={initialState}>
    <UserName />
  </appStore.Provider>
);
```

The `data` prop is available only for fresh, non-persisted stores created by the
factory. Hydrate singleton, caller-provided, or persisted stores explicitly
before rendering. Use `dehydrate()` and `hydrate()` for an RSC or network
handoff.

## Redux DevTools

Import `devtools()` from the separate module so applications that do not use it
do not include the integration:

```ts
import { batch, createStore } from "statelift";
import { devtools } from "statelift/devtools";

const checkoutStore = createStore({ step: "cart" });
const disconnectDevtools = devtools(checkoutStore, { name: "checkout" });

batch(
  checkoutStore,
  () => {
    checkoutStore.state.step = "payment";
  },
  { label: "continue checkout" },
);

disconnectDevtools();
```

The integration is enabled outside production builds by default. When the
browser extension is unavailable, it does nothing and emits no diagnostic.
Time travel restores state through Statelift mutations, so React consumers and
subscribers update.

## Benchmark

The repository's `benchmark/` directory runs the upstream
[js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)
keyed suite for Statelift, MobX, Legend-State, and React-Zustand. From the
repository root, run `./benchmark/run-benchmark.sh`. Each run writes the
upstream raw results and HTML report under `benchmark/results/`.

![Statelift benchmark results](https://github.com/3rd/statelift/assets/59587503/eb09b938-3bfe-4283-8f46-ac14dd572da8)
