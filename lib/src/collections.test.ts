import { useRef } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, mock, spyOn } from "bun:test";
import type { ProxyMap, ProxySet } from "./collections";
import type { Snapshot } from "./store";
import { proxyMap, proxySet } from "./collections";
import { disposePersistence } from "./persist";
import { useStore } from "./react";
import { createConsumer, createStore, hydrate, snapshot } from "./store";

type AssertFalse<T extends false> = T;
type AssertTrue<T extends true> = T;
type _MapSnapshotHasNoSet = AssertFalse<
  "set" extends keyof Snapshot<ProxyMap<string, number>> ? true : false
>;
type _SetSnapshotHasNoAdd = AssertFalse<"add" extends keyof Snapshot<ProxySet<string>> ? true : false>;
type _NativeMapSnapshotKeepsSet = AssertTrue<
  "set" extends keyof Snapshot<Map<string, number>> ? true : false
>;
type _NativeSetSnapshotKeepsAdd = AssertTrue<"add" extends keyof Snapshot<Set<string>> ? true : false>;
describe("proxyMap", () => {
  it("re-renders only readers of the touched key", () => {
    const store = createStore({
      users: proxyMap<string, number>([
        ["a", 1],
        ["b", 2],
      ]),
    });
    const readerA = mock();
    const consumer = createConsumer(store, readerA);
    expect(consumer.proxy.users.get("a")).toEqual(1);

    store.state.users.set("b", 20);
    expect(readerA).toHaveBeenCalledTimes(0);

    store.state.users.set("a", 10);
    expect(readerA.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(store.state.users.get("a")).toEqual(10);

    consumer.destroy();
  });

  it("notifies size readers on add and delete but not on value replacement", () => {
    const store = createStore({ users: proxyMap<string, number>([["a", 1]]) });
    const sizeReader = mock();
    const consumer = createConsumer(store, sizeReader);
    expect(consumer.proxy.users.size).toEqual(1);

    store.state.users.set("a", 99);
    expect(sizeReader).toHaveBeenCalledTimes(0);

    store.state.users.set("b", 2);
    expect(sizeReader).toHaveBeenCalledTimes(1);

    store.state.users.delete("a");
    expect(sizeReader).toHaveBeenCalledTimes(2);

    consumer.destroy();
  });

  it("re-renders iteration readers on add, delete, and value replacement", () => {
    const store = createStore({ users: proxyMap<string, number>([["a", 1]]) });
    const iterationReader = mock();
    const consumer = createConsumer(store, iterationReader);
    expect([...consumer.proxy.users.entries()]).toEqual([["a", 1]]);

    store.state.users.set("a", 2);
    expect(iterationReader).toHaveBeenCalledTimes(1);

    store.state.users.set("b", 3);
    expect(iterationReader).toHaveBeenCalledTimes(2);

    store.state.users.delete("a");
    expect(iterationReader).toHaveBeenCalledTimes(3);

    expect([...store.state.users.keys()]).toEqual(["b"]);
    consumer.destroy();
  });

  it("publishes structural mutations once with entries and size from the same state", () => {
    const store = createStore({
      users: proxyMap<string, number>([
        ["a", 1],
        ["b", 2],
      ]),
    });
    const observed: { entries: [string, number][]; size: number }[] = [];
    const consumer = createConsumer(store, () => {
      observed.push({ entries: [...store.state.users], size: store.state.users.size });
    });
    expect([...consumer.proxy.users]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(consumer.proxy.users.size).toBe(2);

    store.state.users.set("c", 3);
    store.state.users.delete("a");
    store.state.users.clear();

    expect(observed).toEqual([
      {
        entries: [
          ["a", 1],
          ["b", 2],
          ["c", 3],
        ],
        size: 3,
      },
      {
        entries: [
          ["b", 2],
          ["c", 3],
        ],
        size: 2,
      },
      { entries: [], size: 0 },
    ]);
    consumer.destroy();
  });

  it("persists the mutation before propagating a consumer error", async () => {
    let persisted: string | null = null;
    const storage = {
      getItem: () => persisted,
      setItem: (_key: string, value: string) => {
        persisted = value;
      },
      removeItem: () => {
        persisted = null;
      },
    };
    const store = createStore(
      { users: proxyMap<string, number>([["a", 1]]) },
      { persist: { key: "collection-consumer-error", storage } },
    );
    const consumer = createConsumer(store, () => {
      throw new Error("consumer-stop");
    });
    expect([...consumer.proxy.users]).toEqual([["a", 1]]);
    expect(consumer.proxy.users.size).toBe(1);

    expect(() => store.state.users.set("b", 2)).toThrow("consumer-stop");

    expect([...store.state.users]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(store.state.users.size).toBe(2);
    consumer.destroy();

    expect(await disposePersistence(store)).toEqual({ flushed: true });
    const reloaded = createStore(
      { users: proxyMap<string, number>() },
      { persist: { key: "collection-consumer-error", storage } },
    );
    expect([...reloaded.state.users]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(reloaded.state.users.size).toBe(2);
    await disposePersistence(reloaded);
  });

  it("clear notifies key, size, and iteration readers", () => {
    const store = createStore({
      users: proxyMap<string, number>([
        ["a", 1],
        ["b", 2],
      ]),
    });
    const keyReader = mock();
    const sizeReader = mock();
    const iterationReader = mock();
    const c1 = createConsumer(store, keyReader);
    const c2 = createConsumer(store, sizeReader);
    const c3 = createConsumer(store, iterationReader);
    expect(c1.proxy.users.get("a")).toBe(1);
    expect(c2.proxy.users.size).toBe(2);
    expect([...c3.proxy.users]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);

    store.state.users.clear();

    expect(keyReader.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(sizeReader.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(iterationReader.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(store.state.users.size).toEqual(0);
    expect(store.state.users.get("a")).toBeUndefined();
    expect([...store.state.users]).toEqual([]);

    c1.destroy();
    c2.destroy();
    c3.destroy();
  });

  it("uses raw identity and SameValueZero key semantics", () => {
    const key = { id: 1 };
    const store = createStore({ obj: key, tags: proxyMap<{ id: number }, string>() });

    store.state.tags.set(store.state.obj, "via-proxy");

    expect(store.state.tags.get(key)).toEqual("via-proxy");
    expect(store.state.tags.get(store.state.obj)).toEqual("via-proxy");
    const map = proxyMap<number, string>();
    map.set(Number.NaN, "nan");
    expect(map.get(Number.NaN)).toEqual("nan");

    map.set(-0, "zero");
    expect(map.get(0)).toEqual("zero");
    expect(map.size).toEqual(2);
  });

  it("iterates a stable snapshot while mutating", () => {
    const store = createStore({
      users: proxyMap<string, number>([
        ["a", 1],
        ["b", 2],
      ]),
    });
    const seen: string[] = [];

    Reflect.apply(store.state.users.forEach, store.state.users, [
      (_value: number, key: string) => {
        seen.push(key);
        store.state.users.delete("b");
        store.state.users.set("c", 3);
      },
    ]);

    expect(seen).toEqual(["a", "b"]);
    expect(store.state.users.has("c")).toBe(true);
    expect(store.state.users.has("b")).toBe(false);
  });

  it("exposes non-native collections with native forEach callback semantics", () => {
    const map = proxyMap([["a", 1]]);
    const context: { entries: [string, number][] } = { entries: [] };

    expect(map instanceof Map).toBe(false);

    Reflect.apply(map.forEach, map, [
      function (this: typeof context, value: number, key: string, owner: typeof map) {
        this.entries.push([key, value]);
        expect(owner).toBe(map);
      },
      context,
    ]);

    expect(context.entries).toEqual([["a", 1]]);

    const set = proxySet(["a"]);
    const setContext: { values: string[] } = { values: [] };

    expect(set instanceof Set).toBe(false);

    Reflect.apply(set.forEach, set, [
      function (this: typeof setContext, value: string, value2: string, owner: typeof set) {
        expect(value2).toBe(value);
        expect(owner).toBe(set);
        this.values.push(value);
      },
      setContext,
    ]);
    expect(setContext.values).toEqual(["a"]);
  });

  it("snapshots as native collections with snapshotted payloads", () => {
    const store = createStore({
      users: proxyMap<string, { n: number }>([["a", { n: 1 }]]),
      tags: proxySet(["x"]),
    });

    const snap = snapshot(store);

    expect(snap.users instanceof Map).toBe(true);
    expect(snap.users.get("a")).toEqual({ n: 1 });
    expect(snap.tags instanceof Set).toBe(true);
    expect(snap.tags.has("x")).toBe(true);
  });

  it("rebuilds lookup metadata after persistence reload", async () => {
    const key = "collections-persist";
    try {
      const store = createStore({ users: proxyMap<string, number>() }, { persist: key });
      store.state.users.set("a", 1);
      store.state.users.set("b", 2);
      await disposePersistence(store);

      const reloaded = createStore({ users: proxyMap<string, number>() }, { persist: key });
      expect(reloaded.state.users.size).toEqual(2);
      expect(reloaded.state.users.get("a")).toEqual(1);

      reloaded.state.users.set("c", 3);
      expect(reloaded.state.users.get("c")).toEqual(3);
      expect(reloaded.state.users.get("b")).toEqual(2);
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("re-renders components reading through useStore selectors", () => {
    const store = createStore({ users: proxyMap<string, number>([["a", 1]]) });
    const { result } = renderHook(() => {
      const count = useRef(0);
      count.current++;
      return { count: count.current, state: useStore(store, (state) => state.users.get("a")) };
    });
    expect(result.current.state).toEqual(1);
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.users.set("b", 9);
    });
    expect(result.current.count).toEqual(1);

    act(() => {
      store.state.users.set("a", 5);
    });
    expect(result.current.state).toEqual(5);
    expect(result.current.count).toEqual(2);
  });
});

describe("proxySet algebra", () => {
  it("computes TC39-style results as new proxySets", () => {
    const store = createStore({ a: proxySet([1, 2, 3]), b: proxySet([2, 3, 4]) });

    expect([...store.state.a.union(store.state.b)]).toEqual([1, 2, 3, 4]);
    expect([...store.state.a.intersection(store.state.b)]).toEqual([2, 3]);
    expect([...store.state.a.difference(store.state.b)]).toEqual([1]);
    expect([...store.state.a.symmetricDifference(store.state.b)]).toEqual([1, 4]);
    expect(store.state.a.isSubsetOf([1, 2, 3, 9])).toBe(true);
    expect(store.state.a.isSubsetOf([1, 2])).toBe(false);
    expect(store.state.a.isSupersetOf([1, 2])).toBe(true);
    expect(store.state.a.isSupersetOf([1, 5])).toBe(false);
    const result = store.state.a.union([9]);
    store.state.a.add(5);
    expect([...result]).toEqual([1, 2, 3, 9]);
    expect(result instanceof Set).toBe(false);
  });

  it("uses SameValueZero and raw identity across proxies", () => {
    const member = { id: 1 };
    const store = createStore({ ref: member, a: proxySet<unknown>([member, Number.NaN]) });

    expect(store.state.a.isSupersetOf([store.state.ref, Number.NaN])).toBe(true);
  });
});

describe("proxySet", () => {
  it("tracks membership per value with add/delete granularity", () => {
    const store = createStore({ selected: proxySet<string>(["a"]) });
    const hasReader = mock();
    const consumer = createConsumer(store, hasReader);
    expect(consumer.proxy.selected.has("a")).toBe(true);

    store.state.selected.add("a");
    expect(hasReader).toHaveBeenCalledTimes(0);

    store.state.selected.delete("a");
    expect(hasReader.mock.calls.length).toBeGreaterThanOrEqual(1);

    store.state.selected.add("b");
    expect([...store.state.selected]).toEqual(["b"]);
    expect(store.state.selected.size).toEqual(1);
    expect(store.state.selected.has("a")).toBe(false);

    consumer.destroy();
  });

  it("publishes add once with members and size from the same state", () => {
    const store = createStore({ selected: proxySet<string>(["a"]) });
    const observed: { size: number; values: string[] }[] = [];
    const consumer = createConsumer(store, () => {
      observed.push({ size: store.state.selected.size, values: [...store.state.selected] });
    });
    expect([...consumer.proxy.selected]).toEqual(["a"]);
    expect(consumer.proxy.selected.size).toBe(1);

    store.state.selected.add("b");

    expect(observed).toEqual([{ size: 2, values: ["a", "b"] }]);
    consumer.destroy();
  });
});

describe("collection import and snapshots", () => {
  it("replaces equal-sized and shrinking collections from the persisted slots shape", () => {
    const store = createStore({
      users: proxyMap<string, number>([
        ["old-a", 1],
        ["old-b", 2],
      ]),
      tags: proxySet(["old-a", "old-b"]),
    });
    const payload = {
      users: { slots: { s0: { key: "saved", value: 9 } }, size: 1 },
      tags: { slots: { s0: { key: "saved" } }, size: 1 },
    };

    Reflect.apply(hydrate, undefined, [store, payload]);

    expect([...store.state.users]).toEqual([["saved", 9]]);
    expect(store.state.users.get("old-a")).toBeUndefined();
    expect([...store.state.tags]).toEqual(["saved"]);
    store.state.users.set("next", 10);
    expect([...store.state.users]).toEqual([
      ["saved", 9],
      ["next", 10],
    ]);
  });

  it("validates every tagged map entry before changing the live map", () => {
    const store = createStore({ users: proxyMap<string, number>([["kept", 1]]) });
    const malformed = { users: { __map: [["valid", 2], ["missing-value"]] } };

    expect(() => Reflect.apply(hydrate, undefined, [store, malformed])).toThrow(
      "statelift: cannot restore proxyMap from the supplied value",
    );
    expect([...store.state.users]).toEqual([["kept", 1]]);
  });

  it("guards reactive collection snapshots against mutation in development", () => {
    const store = createStore({ users: proxyMap<string, number>([["a", 1]]), tags: proxySet(["x"]) });
    const first = snapshot(store);

    expect(first.users instanceof Map).toBe(true);
    expect(first.tags instanceof Set).toBe(true);
    const setMapValue: unknown = Reflect.get(first.users, "set");
    const addSetValue: unknown = Reflect.get(first.tags, "add");
    if (typeof setMapValue !== "function" || typeof addSetValue !== "function") {
      throw new TypeError("collection mutator was not installed");
    }
    expect(() => Reflect.apply(setMapValue, first.users, ["b", 2])).toThrow(
      "statelift: snapshots are immutable",
    );
    expect(() => Reflect.apply(addSetValue, first.tags, ["y"])).toThrow("statelift: snapshots are immutable");

    const second = snapshot(store);
    expect(second).toBe(first);
    expect([...second.users]).toEqual([["a", 1]]);
    expect([...second.tags]).toEqual(["x"]);
  });
});

describe("persisted slot tolerance", () => {
  it("round-trips undefined map keys, map values, and set members through persist", async () => {
    const key = "collections-undefined";
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createStore(
        {
          users: proxyMap<string | undefined, number | undefined>(),
          tags: proxySet<string | undefined>(),
          flags: proxyMap<string | undefined, number | undefined>(),
        },
        { persist: key },
      );
      store.state.users.set("a", undefined);
      store.state.users.set(undefined, 2);
      store.state.tags.add(undefined);
      store.state.flags.set(undefined, undefined);
      await disposePersistence(store);

      const reloaded = createStore(
        {
          users: proxyMap<string | undefined, number | undefined>(),
          tags: proxySet<string | undefined>(),
          flags: proxyMap<string | undefined, number | undefined>(),
        },
        { persist: key },
      );
      expect(reloaded.state.users.size).toEqual(2);
      expect(reloaded.state.users.has("a")).toBe(true);
      expect(reloaded.state.users.get("a")).toBeUndefined();
      expect(reloaded.state.users.get(undefined)).toEqual(2);
      expect(reloaded.state.tags.has(undefined)).toBe(true);
      expect(reloaded.state.flags.size).toEqual(1);
      expect(reloaded.state.flags.has(undefined)).toBe(true);
      expect(reloaded.state.flags.get(undefined)).toBeUndefined();
    } finally {
      localStorage.removeItem(key);
      warnSpy.mockRestore();
    }
  });

  it("rejects slots with unknown keys", () => {
    const store = createStore({ users: proxyMap<string, number>([["kept", 1]]), tags: proxySet(["kept"]) });
    const malformedPayloads = [
      { users: { slots: { s0: { key: "a", value: 1, extra: 2 } }, size: 1 } },
      { tags: { slots: { s0: { key: "a", value: 1 } }, size: 1 } },
    ];

    for (const malformed of malformedPayloads) {
      expect(() => Reflect.apply(hydrate, undefined, [store, malformed])).toThrow(
        /cannot restore proxy(Map|Set) from the supplied value/,
      );
    }
    expect([...store.state.users]).toEqual([["kept", 1]]);
    expect([...store.state.tags]).toEqual(["kept"]);
  });
});
