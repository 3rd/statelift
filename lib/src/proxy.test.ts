/* eslint-disable @typescript-eslint/no-magic-numbers */
/* eslint-disable no-param-reassign */
import { vi } from "vitest";
import { createDeepProxy, createRootProxy, ProxyCallbacks, unwrapDeepProxy, unwrapProxy } from "./proxy";

describe("createDeepProxy", () => {
  it("creates a deep proxy for the target object", () => {
    const target = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = {};

    const proxy = createDeepProxy(target, { callbacks });

    expect(proxy).not.toBe(target);
    expect(proxy).toEqual(target);
  });

  it("retrieves the value and calls the get callback when a property is accessed", () => {
    const target = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = { get: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    // access 1 time: foo
    expect(proxy.foo).toBe("boo");
    expect(callbacks.get).toHaveBeenCalledTimes(1);
    expect(callbacks.get).toHaveBeenNthCalledWith(1, target, "foo", proxy, "boo");

    // access 2 times: bar, baz
    expect(proxy.bar.baz).toBe("zoo");
    expect(callbacks.get).toHaveBeenLastCalledWith(target.bar, "baz", expect.anything(), "zoo");
  });

  it("mutates the target and calls the set callback when a property is set", () => {
    const target = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    // set 1 time: foo -> primitive
    proxy.foo = "new boo";
    expect(callbacks.set).toHaveBeenCalledTimes(1);
    expect(callbacks.set).toHaveBeenNthCalledWith(
      1,
      target,
      "foo",
      "new boo",
      expect.anything(),
      false,
      undefined,
    );
    expect(target.foo).toBe("new boo");

    // set 1 time: bar -> object
    proxy.bar = { baz: "new zoo" };
    expect(callbacks.set).toHaveBeenCalledTimes(2);
    expect(callbacks.set).toHaveBeenNthCalledWith(
      2,
      target,
      "bar",
      { baz: "new zoo" },
      expect.anything(),
      false,
      undefined,
    );
    expect(target.bar).toEqual({ baz: "new zoo" });
  });

  it("mutates the target and calls the delete callback on property delete", () => {
    const target: { foo?: string; bar?: { baz?: string } } = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = { deleteProperty: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    // delete 1 time: foo
    delete proxy.foo;
    expect(callbacks.deleteProperty).toHaveBeenNthCalledWith(1, target, "foo");
    expect("foo" in target).toBe(false);

    // delete 1 time: bar.baz
    delete proxy.bar!.baz;
    expect(callbacks.deleteProperty).toHaveBeenNthCalledWith(2, target.bar!, "baz");
    expect("baz" in target.bar!).toBe(false);
  });

  it("resolves local getters on the target object", () => {
    const target = {
      foo: "baz",
      get bar() {
        return this.foo;
      },
    };

    const proxy = createDeepProxy(target);

    expect(proxy.foo).toBe("baz");
    expect(proxy.bar).toBe("baz");

    proxy.foo = "boo";
    expect(proxy.foo).toBe("boo");
  });

  it("calls the ownKeys callback when Object.keys() is used", () => {
    const target = { foo: "boo", bar: "baz" };
    const callbacks: Partial<ProxyCallbacks> = { ownKeys: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    Object.keys(proxy);
    expect(callbacks.ownKeys).toHaveBeenCalledTimes(1);
    expect(callbacks.ownKeys).toHaveBeenCalledWith(target);
  });

  it("calls the ownKeys callback when for...in loop is used", () => {
    const target = { foo: "boo", bar: "baz" };
    const callbacks: Partial<ProxyCallbacks> = { ownKeys: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    const keys: string[] = [];
    for (const key in proxy) {
      keys.push(key);
    }
    expect(keys).toEqual(["foo", "bar"]);
    expect(callbacks.ownKeys).toHaveBeenCalledTimes(1);
  });

  it("calls the ownKeys callback when spread operator is used", () => {
    const target = { foo: "boo", bar: "baz" };
    const callbacks: Partial<ProxyCallbacks> = { ownKeys: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    const spread = { ...proxy };
    expect(spread).toEqual({ foo: "boo", bar: "baz" });
    expect(callbacks.ownKeys).toHaveBeenCalledTimes(1);
  });

  it("passes isNewProperty=true when setting a new property", () => {
    const target: { foo: string; newProp?: string } = { foo: "boo" };
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    proxy.newProp = "new value";
    expect(callbacks.set).toHaveBeenCalledTimes(1);
    expect(callbacks.set).toHaveBeenCalledWith(
      target,
      "newProp",
      "new value",
      expect.anything(),
      true,
      undefined,
    );
  });

  it("passes isNewProperty=false when updating an existing property", () => {
    const target = { foo: "boo" };
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    proxy.foo = "updated";
    expect(callbacks.set).toHaveBeenCalledTimes(1);
    expect(callbacks.set).toHaveBeenCalledWith(target, "foo", "updated", expect.anything(), false, undefined);
  });

  it("passes oldArrayLength when truncating array via length property", () => {
    const target = [1, 2, 3, 4, 5];
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn(), ownKeys: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    proxy.length = 2;
    expect(callbacks.set).toHaveBeenCalledWith(target, "length", 2, expect.anything(), false, 5);
    expect(callbacks.ownKeys).toHaveBeenCalledWith(target);
  });

  it("passes oldArrayLength but does not call ownKeys when expanding array", () => {
    const target = [1, 2, 3];
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn(), ownKeys: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    proxy.length = 10;
    // oldArrayLength is always passed when setting length on an array
    expect(callbacks.set).toHaveBeenCalledWith(target, "length", 10, expect.anything(), false, 3);
    // ownKeys is NOT called because this is expansion, not truncation
    expect(callbacks.ownKeys).not.toHaveBeenCalled();
  });

  it("passes oldArrayLength but does not call ownKeys when setting length to same value", () => {
    const target = [1, 2, 3];
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn(), ownKeys: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    proxy.length = 3;
    // oldArrayLength is always passed when setting length on an array
    expect(callbacks.set).toHaveBeenCalledWith(target, "length", 3, expect.anything(), false, 3);
    // ownKeys is NOT called because no truncation occurred
    expect(callbacks.ownKeys).not.toHaveBeenCalled();
  });

  it("calls ownKeys callback when array is truncated", () => {
    const target = [1, 2, 3, 4, 5];
    const callbacks: Partial<ProxyCallbacks> = { ownKeys: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    proxy.length = 2;
    expect(callbacks.ownKeys).toHaveBeenCalledTimes(1);
    expect(callbacks.ownKeys).toHaveBeenCalledWith(target);
  });
});

describe("createRootProxy", () => {
  it("creates a root proxy that wraps the result of the builder function called with the root proxy itself", () => {
    const proxy = createRootProxy<{ top: number; computed: { doubleTop: number } }>((root) => ({
      top: 10,
      computed: {
        get doubleTop() {
          return root.top * 2;
        },
      },
    }));

    expect(proxy.top).toBe(10);
    expect(proxy.computed.doubleTop).toBe(20);
  });

  it("handles direct mutations", () => {
    const proxy = createRootProxy<{
      nested: { value: number };
      computed: { doubleNestedValue: number };
    }>((root) => ({
      nested: {
        value: 10,
      },
      computed: {
        get doubleNestedValue() {
          return root.nested.value * 2;
        },
      },
    }));

    expect(proxy.nested.value).toBe(10);
    expect(proxy.computed.doubleNestedValue).toBe(20);

    proxy.nested.value = 20;
    expect(proxy.computed.doubleNestedValue).toBe(40);
  });

  it("handles function mutations that reference the root", () => {
    const proxy = createRootProxy<{
      top: number;
      very: { nested: { value: number } };
      deep: { increment: () => void };
    }>((root) => ({
      top: 10,
      very: {
        nested: {
          value: 10,
        },
      },
      deep: {
        increment() {
          root.top++;
          root.very.nested.value++;
        },
      },
    }));

    expect(proxy.top).toBe(10);

    proxy.deep.increment();
    expect(proxy.top).toBe(11);
    expect(proxy.very.nested.value).toBe(11);
  });
});

describe("has trap", () => {
  it("calls get callback when 'in' operator is used", () => {
    const target = { foo: "bar", nested: { a: 1 } };
    const callbacks: Partial<ProxyCallbacks> = { get: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    const hasFoo = "foo" in proxy;
    expect(hasFoo).toBe(true);
    expect(callbacks.get).toHaveBeenCalledWith(target, "foo", target, true);

    const hasMissing = "missing" in proxy;
    expect(hasMissing).toBe(false);
    expect(callbacks.get).toHaveBeenCalledWith(target, "missing", target, false);
  });

  it("tracks 'in' operator on nested objects", () => {
    const target = { nested: { exists: true } };
    const callbacks: Partial<ProxyCallbacks> = { get: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    const hasExists = "exists" in proxy.nested;
    expect(hasExists).toBe(true);
    expect(callbacks.get).toHaveBeenCalledWith(target.nested, "exists", target.nested, true);
  });
});

describe("defineProperty trap", () => {
  it("calls set callback when Object.defineProperty is used", () => {
    const target: { foo: string; defined?: string } = { foo: "bar" };
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    Object.defineProperty(proxy, "defined", {
      value: "via defineProperty",
      writable: true,
      enumerable: true,
      configurable: true,
    });

    expect(callbacks.set).toHaveBeenCalledWith(
      target,
      "defined",
      "via defineProperty",
      target,
      true,
      undefined,
    );
    expect(target.defined).toBe("via defineProperty");
  });

  it("passes isNewProperty=false when redefining existing property", () => {
    const target = { existing: "old" };
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    Object.defineProperty(proxy, "existing", {
      value: "new",
      writable: true,
      enumerable: true,
      configurable: true,
    });

    expect(callbacks.set).toHaveBeenCalledWith(target, "existing", "new", target, false, undefined);
  });
});

describe("built-in objects handling", () => {
  it("does not proxy built-in objects (Map, Set, Date, etc.)", () => {
    const target = {
      date: new Date("2024-01-01"),
      map: new Map([["a", 1]]),
      set: new Set([1, 2, 3]),
      regex: /test/gi,
    };

    const proxy = createDeepProxy(target);

    expect(() => proxy.date.getTime()).not.toThrow();
    expect(() => proxy.map.get("a")).not.toThrow();
    expect(() => proxy.set.has(1)).not.toThrow();
    expect(() => proxy.regex.test("test")).not.toThrow();
  });

  it("throws in strict mode when built-in objects are accessed", () => {
    const target = { date: new Date() };
    const proxy = createDeepProxy(target, { strict: true });

    expect(() => proxy.date).toThrow(/Built-in object "Date" detected/);
  });

  it("throws in strict mode for Map", () => {
    const target = { map: new Map() };
    const proxy = createDeepProxy(target, { strict: true });

    expect(() => proxy.map).toThrow(/Built-in object "Map" detected/);
  });

  it("throws in strict mode for Set", () => {
    const target = { set: new Set() };
    const proxy = createDeepProxy(target, { strict: true });

    expect(() => proxy.set).toThrow(/Built-in object "Set" detected/);
  });

  it("does not throw in strict mode for plain objects and arrays", () => {
    const target = { obj: { a: 1 }, arr: [1, 2, 3] };
    const proxy = createDeepProxy(target, { strict: true });

    expect(() => proxy.obj.a).not.toThrow();
    expect(() => proxy.arr[0]).not.toThrow();
  });
});

describe("unwrapDeepProxy", () => {
  it("returns primitives as-is", () => {
    expect(unwrapDeepProxy(42)).toBe(42);
    expect(unwrapDeepProxy("hello")).toBe("hello");
    expect(unwrapDeepProxy(true)).toBe(true);
    expect(unwrapDeepProxy(null)).toBe(null);
    expect(unwrapDeepProxy(undefined)).toBe(undefined);
  });

  it("returns functions as-is", () => {
    const fn = () => 42;
    expect(unwrapDeepProxy(fn)).toBe(fn);
  });

  it("unwraps a simple proxied object", () => {
    const target = { foo: "bar", count: 42 };
    const proxy = createDeepProxy(target);

    const result = unwrapDeepProxy(proxy);

    expect(result).toEqual(target);
    expect(result).not.toBe(proxy);
    // result is a new plain object, not the original target
    expect(unwrapProxy(result)).toBe(result);
  });

  it("unwraps nested proxied objects", () => {
    const target = { user: { name: "alice", profile: { age: 30 } } };
    const proxy = createDeepProxy(target);

    const result = unwrapDeepProxy(proxy);

    expect(result).toEqual(target);
    expect(result.user).toEqual(target.user);
    expect(result.user.profile).toEqual(target.user.profile);

    // verify all levels are plain objects
    expect(unwrapProxy(result)).toBe(result);
    expect(unwrapProxy(result.user)).toBe(result.user);
    expect(unwrapProxy(result.user.profile)).toBe(result.user.profile);
  });

  it("unwraps arrays with proxied elements", () => {
    const target = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const proxy = createDeepProxy(target);

    const result = unwrapDeepProxy(proxy);

    expect(result).toEqual(target);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(3);

    // verify array elements are plain objects
    for (const item of result.items) {
      expect(unwrapProxy(item)).toBe(item);
    }
  });

  it("unwraps deeply nested mixed structures", () => {
    const target = {
      users: [
        { name: "alice", tags: ["admin", "user"] },
        { name: "bob", tags: ["user"] },
      ],
      meta: { count: 2, nested: { deep: { value: 42 } } },
    };
    const proxy = createDeepProxy(target);

    const result = unwrapDeepProxy(proxy);

    expect(result).toEqual(target);

    // verify structure is fully unwrapped
    expect(unwrapProxy(result.meta.nested.deep)).toBe(result.meta.nested.deep);
    expect(unwrapProxy(result.users[0])).toBe(result.users[0]);
  });

  it("handles empty objects and arrays", () => {
    const target = { empty: {}, arr: [] };
    const proxy = createDeepProxy(target);

    const result = unwrapDeepProxy(proxy);

    expect(result).toEqual(target);
    expect(result.empty).toEqual({});
    expect(result.arr).toEqual([]);
  });

  it("preserves values after mutations", () => {
    const target = { count: 0, items: [1, 2, 3] };
    const proxy = createDeepProxy(target);

    proxy.count = 100;
    proxy.items.push(4);

    const result = unwrapDeepProxy(proxy);

    expect(result.count).toBe(100);
    expect(result.items).toEqual([1, 2, 3, 4]);
  });

  it("returns new object, not original target", () => {
    const target = { foo: "bar" };
    const proxy = createDeepProxy(target);

    const result = unwrapDeepProxy(proxy);

    // result has same values but is a new object
    expect(result).toEqual(target);
    expect(result).not.toBe(target);
  });
});
