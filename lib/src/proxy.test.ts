import { vi } from "vitest";
import { ProxyCallbacks, createDeepProxy, createRootProxy } from "./proxy";

describe("createDeepProxy", () => {
  it("creates a deep proxy for the target object", () => {
    const target = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = {};

    const proxy = createDeepProxy(target, { callbacks });

    expect(proxy.instance).not.toBe(target);
    expect(proxy.instance).toEqual(target);
    expect(proxy.callbacks).toBe(callbacks);
  });

  it("caches proxies, indexing them by root symbol + target pair", () => {
    const target = { foo: "boo", bar: { baz: "zoo" } };
    const rootSymbol = Symbol("root");

    const proxy1 = createDeepProxy(target, { rootSymbol });
    const proxy2 = createDeepProxy(target, { rootSymbol });
    expect(proxy1).toBe(proxy2);

    const proxy3 = createDeepProxy(target);
    expect(proxy1).not.toBe(proxy3);
  });
});

describe("createRootProxy", () => {
  it.only("creates a root proxy that wraps the result of the builder function called with the root proxy itself", () => {
    const proxy = createRootProxy<{ nested: { foo: number }; computed: { doubleFoo: number } }>(
      (root) => ({
        nested: { foo: 10 },
        computed: {
          get doubleFoo() {
            return root.nested.foo * 2;
          },
        },
      })
    );

    expect(proxy.nested.foo).toBe(10);
    expect(proxy.computed.doubleFoo).toBe(20);

    proxy.nested.foo = 20;
    expect(proxy.computed.doubleFoo).toBe(40);
  });
});

describe("proxy", () => {
  it("retrieves the value and calls the get callback when a property is accessed", () => {
    const target = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = { get: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    // access 1 time: foo
    expect(proxy.instance.foo).toBe("boo");
    expect(callbacks.get).toHaveBeenCalledTimes(1);
    expect(callbacks.get).toHaveBeenNthCalledWith(1, expect.anything(), target, "foo", "boo");

    // access 2 times: bar, baz
    expect(proxy.instance.bar.baz).toBe("zoo");
    expect(callbacks.get).toHaveBeenCalledTimes(3);
    expect(callbacks.get).toHaveBeenNthCalledWith(2, expect.anything(), target, "bar", target.bar);
    expect(callbacks.get).toHaveBeenNthCalledWith(3, expect.anything(), target.bar, "baz", "zoo");
  });

  it("mutates the target and calls the set callback when a property is set", () => {
    const target = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = { set: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    // set 1 time: foo -> primitive
    proxy.instance.foo = "new boo";
    expect(callbacks.set).toHaveBeenCalledTimes(1);
    expect(callbacks.set).toHaveBeenNthCalledWith(1, expect.anything(), target, "foo", "new boo");
    expect(target.foo).toBe("new boo");

    // set 1 time: bar -> object
    proxy.instance.bar = { baz: "new zoo" };
    expect(callbacks.set).toHaveBeenCalledTimes(2);
    expect(callbacks.set).toHaveBeenNthCalledWith(2, expect.anything(), target, "bar", {
      baz: "new zoo",
    });
    expect(target.bar).toEqual({ baz: "new zoo" });
  });

  it("mutates the target and calls the delete callback on property delete", () => {
    const target: { foo?: string; bar?: { baz?: string } } = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = { delete: vi.fn() };

    const proxy = createDeepProxy(target, { callbacks });

    // delete 1 time: foo
    delete proxy.instance.foo;
    expect(callbacks.delete).toHaveBeenCalledTimes(1);
    expect(callbacks.delete).toHaveBeenNthCalledWith(1, expect.anything(), target, "foo");
    expect("foo" in target).toBe(false);

    // delete 1 time: bar.baz
    delete proxy.instance.bar!.baz;
    expect(callbacks.delete).toHaveBeenCalledTimes(2);
    expect(callbacks.delete).toHaveBeenNthCalledWith(2, expect.anything(), target.bar!, "baz");
    expect("baz" in target.bar!).toBe(false);
  });

  it("tracks proxied proxies and calls parent callbacks", () => {
    const innerCallbacks: Partial<ProxyCallbacks> = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const inner = createDeepProxy(
      { foo: "bar" },
      {
        rootSymbol: Symbol("inner"),
        callbacks: innerCallbacks,
      }
    );

    const outerCallbacks: Partial<ProxyCallbacks> = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const outer = createDeepProxy(inner.instance, {
      rootSymbol: Symbol("outer"),
      callbacks: outerCallbacks,
    });

    // access inner 1 time: foo
    expect(inner.instance.foo).toBe("bar");
    expect(innerCallbacks.get).toHaveBeenCalledTimes(1);
    expect(outerCallbacks.get).toHaveBeenCalledTimes(1);

    // access outer 1 time: foo
    expect(outer.instance.foo).toBe("bar");
    expect(innerCallbacks.get).toHaveBeenCalledTimes(2);
    expect(outerCallbacks.get).toHaveBeenCalledTimes(3); // outer, inner, outer
  });
});
