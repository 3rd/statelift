/* eslint-disable @typescript-eslint/no-magic-numbers */
/* eslint-disable no-param-reassign */
import { vi } from "vitest";
import { createDeepProxy, createRootProxy, ProxyCallbacks } from "./proxy";

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
    expect(callbacks.set).toHaveBeenNthCalledWith(1, target, "foo", "new boo", expect.anything(), false, undefined);
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
