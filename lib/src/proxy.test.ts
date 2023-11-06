import { vi } from "vitest";
import { ProxyCallbacks, createDeepProxy } from "./proxy";

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
});
