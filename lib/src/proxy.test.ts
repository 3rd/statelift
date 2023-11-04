import { describe, it, vi } from "vitest";
import { createDeepProxy } from "./proxy";

describe("proxy", () => {
  it("should create a proxy", ({ expect }) => {
    const target = {
      foo: "bar",
      baz: {
        qux: "quux",
      },
    };

    const proxy = createDeepProxy(target);

    expect(proxy.foo).toBe("bar");
    expect(proxy.baz.qux).toBe("quux");
  });

  it("should create a proxy with callbacks", ({ expect }) => {
    const target = {
      foo: "bar",
      baz: {
        qux: "quux",
      },
    };

    const callbacks = {
      get: vi.fn(),
      set: vi.fn(),
    };

    const proxy = createDeepProxy(target, { callbacks });

    // accesses 3 times: foo, baz, qux
    expect(proxy.foo).toBe("bar");
    expect(proxy.baz.qux).toBe("quux");

    // accesses 1 time: baz
    proxy.foo = "bar2";
    proxy.baz.qux = "quux2";

    expect(callbacks.get).toBeCalledTimes(4);
    expect(callbacks.set).toBeCalledTimes(2);
  });
});
