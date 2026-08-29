import { describe, expect, it, mock } from "bun:test";
import { runInNewContext } from "node:vm";
import type { CompoundCompletion, ProxyCallbacks } from "./proxy";
import {
  createDeepProxy,
  createRootProxy,
  createStoreRootProxy,
  opaqueObjectType,
  snapshotTree,
  UNWRAP_PROXY_KEY,
  unwrapDeepProxy,
  unwrapProxy,
} from "./proxy";

describe("createDeepProxy", () => {
  it("retrieves the value and calls the get callback when a property is accessed", () => {
    const target = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = { get: mock() };

    const proxy = createDeepProxy(target, { callbacks });

    expect(proxy.foo).toBe("boo");
    expect(callbacks.get).toHaveBeenCalledTimes(1);
    expect(callbacks.get).toHaveBeenNthCalledWith(1, target, "foo", proxy);

    expect(proxy.bar.baz).toBe("zoo");
    expect(callbacks.get).toHaveBeenLastCalledWith(target.bar, "baz", expect.anything());
  });

  it("reports existing and new property writes", () => {
    const target: { foo: string; added?: string } = { foo: "boo" };
    const callbacks: Partial<ProxyCallbacks> = { set: mock() };

    const proxy = createDeepProxy(target, { callbacks });

    proxy.foo = "new boo";
    proxy.added = "new value";

    expect(callbacks.set).toHaveBeenCalledTimes(2);
    expect(callbacks.set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target,
        prop: "foo",
        value: "new boo",
        isNewProperty: false,
        oldValue: "boo",
      }),
    );
    expect(callbacks.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target,
        prop: "added",
        value: "new value",
        isNewProperty: true,
        oldValue: undefined,
      }),
    );
    expect(target).toEqual({ foo: "new boo", added: "new value" });
  });

  it("mutates the target and calls the delete callback on property delete", () => {
    const target: { foo?: string; bar?: { baz?: string } } = { foo: "boo", bar: { baz: "zoo" } };
    const callbacks: Partial<ProxyCallbacks> = { deleteProperty: mock() };

    const proxy = createDeepProxy(target, { callbacks });

    delete proxy.foo;
    expect(callbacks.deleteProperty).toHaveBeenNthCalledWith(1, target, "foo", "boo");
    expect("foo" in target).toBe(false);

    const nestedTarget = target.bar;
    if (nestedTarget === undefined) throw new Error("nested proxy target is missing");
    const nestedProxy = proxy.bar;
    if (nestedProxy === undefined) throw new Error("nested proxy is missing");
    delete nestedProxy.baz;
    expect(callbacks.deleteProperty).toHaveBeenNthCalledWith(2, nestedTarget, "baz", "zoo");
    expect("baz" in nestedTarget).toBe(false);
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
    const callbacks: Partial<ProxyCallbacks> = { ownKeys: mock() };

    const proxy = createDeepProxy(target, { callbacks });

    Object.keys(proxy);
    expect(callbacks.ownKeys).toHaveBeenCalledTimes(1);
    expect(callbacks.ownKeys).toHaveBeenCalledWith(target);
  });

  it("reports array length changes and suppresses a same-length write", () => {
    const target = [1, 2, 3];
    const callbacks: Partial<ProxyCallbacks> = { set: mock(), ownKeys: mock() };

    const proxy = createDeepProxy(target, { callbacks });

    proxy.length = 1;
    proxy.length = 4;
    proxy.length = 4;

    expect(callbacks.set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ target, prop: "length", value: 1, oldArrayLength: 3, newArrayLength: 1 }),
    );
    expect(callbacks.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ target, prop: "length", value: 4, oldArrayLength: 1, newArrayLength: 4 }),
    );
    expect(callbacks.set).toHaveBeenCalledTimes(2);
    expect(callbacks.ownKeys).not.toHaveBeenCalled();
    expect(target.length).toBe(4);
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
    proxy.top = 20;
    expect(proxy.computed.doubleTop).toBe(40);
  });
});

describe("tracking view identity", () => {
  it("uses the revocable root for cyclic root aliases", () => {
    type CyclicRoot = { self: CyclicRoot };
    const { createView } = createStoreRootProxy<CyclicRoot>((root) => ({ self: root }), {
      callbacks: {},
    });
    const view = createView({
      beginRead: () => false,
      endRead: () => {},
      trackGet: () => {},
      trackOwnKeys: () => {},
    });
    const { proxy, revoke } = view.createRevocableRoot();
    const cyclicAlias: unknown = Reflect.get(proxy, "self");
    if (typeof cyclicAlias !== "object" || cyclicAlias === null) {
      throw new Error("cyclic root alias is missing");
    }

    expect(cyclicAlias).toBe(proxy);

    revoke();
    expect(() => Reflect.get(cyclicAlias, "self")).toThrow();
  });
});

describe("has trap", () => {
  it("calls get callback when 'in' operator is used", () => {
    const target = { foo: "bar", nested: { a: 1 } };
    const callbacks: Partial<ProxyCallbacks> = { get: mock() };

    const proxy = createDeepProxy(target, { callbacks });

    const hasFoo = "foo" in proxy;
    expect(hasFoo).toBe(true);
    expect(callbacks.get).toHaveBeenCalledWith(target, "foo", target);

    const hasMissing = "missing" in proxy;
    expect(hasMissing).toBe(false);
    expect(callbacks.get).toHaveBeenCalledWith(target, "missing", target);
  });
});

describe("defineProperty trap", () => {
  it("reports new and replaced property descriptors", () => {
    const target: { defined?: string } = {};
    const callbacks: Partial<ProxyCallbacks> = { defineProperty: mock() };

    const proxy = createDeepProxy(target, { callbacks });

    Object.defineProperty(proxy, "defined", {
      value: "via defineProperty",
      writable: true,
      enumerable: true,
      configurable: true,
    });

    expect(callbacks.defineProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        target,
        prop: "defined",
        before: undefined,
        after: {
          value: "via defineProperty",
          writable: true,
          enumerable: true,
          configurable: true,
        },
      }),
    );
    expect(target.defined).toBe("via defineProperty");

    Object.defineProperty(proxy, "defined", {
      value: "new",
      writable: true,
      enumerable: true,
      configurable: true,
    });

    expect(callbacks.defineProperty).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target,
        prop: "defined",
        before: expect.objectContaining({ value: "via defineProperty" }),
        after: expect.objectContaining({ value: "new" }),
      }),
    );
  });
});

describe("built-in objects handling", () => {
  it("strict mode rejects built-ins but accepts plain objects and arrays", () => {
    const target = { date: new Date(), map: new Map(), obj: { a: 1 }, arr: [1, 2, 3] };
    const proxy = createDeepProxy(target, { strict: true });

    expect(() => proxy.date).toThrow(/strict mode rejects Date/);
    expect(() => proxy.map).toThrow(/use proxyMap\(\)\/proxySet\(\) for collections/);
    expect(() => proxy.obj.a).not.toThrow();
    expect(() => proxy.arr[0]).not.toThrow();
  });
});

describe("unwrapDeepProxy", () => {
  it("returns non-object values as-is", () => {
    const fn = () => 42;

    expect(unwrapDeepProxy(null)).toBe(null);
    expect(unwrapDeepProxy(fn)).toBe(fn);
  });

  it("copies nested proxied records and arrays without proxy wrappers", () => {
    const target = { users: [{ name: "alice", profile: { age: 30 } }] };
    const proxy = createDeepProxy(target);

    const result = unwrapDeepProxy(proxy);
    const firstUser = result.users[0];
    if (firstUser === undefined) throw new Error("unwrapped user is missing");

    expect(result).toEqual(target);
    expect(result).not.toBe(target);
    expect(result.users).not.toBe(target.users);
    expect(firstUser).not.toBe(target.users[0]);
    expect(unwrapProxy(result)).toBe(result);
    expect(unwrapProxy(firstUser)).toBe(firstUser);
    expect(unwrapProxy(firstUser.profile)).toBe(firstUser.profile);
  });

  it("copies shallow-frozen records and their mutable children", () => {
    const nested = { count: 0 };
    const frozen = Object.freeze({ nested });

    const result = unwrapDeepProxy(frozen);

    expect(result).toEqual(frozen);
    expect(result).not.toBe(frozen);
    expect(result.nested).not.toBe(nested);
    expect(Object.isFrozen(result)).toBe(false);
    expect(Reflect.set(result, "added", true)).toBe(true);
  });
});

describe("snapshotTree", () => {
  it("isolates snapshots from mutable children of shallow-frozen records", () => {
    const nested = { count: 0 };
    const frozen = Object.freeze({ nested });

    const result: unknown = snapshotTree(frozen, { freeze: true });
    if (typeof result !== "object" || result === null) throw new Error("snapshot root is missing");
    const resultNested: unknown = Reflect.get(result, "nested");
    if (typeof resultNested !== "object" || resultNested === null) {
      throw new Error("snapshot nested value is missing");
    }
    nested.count = 1;

    expect(result).not.toBe(frozen);
    expect(resultNested).not.toBe(nested);
    expect(Reflect.get(resultNested, "count")).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(resultNested)).toBe(true);
  });
});

describe("frozen objects", () => {
  it("returns frozen objects with their original identity and readable children", () => {
    const frozen = Object.freeze({ inner: { a: 1 } });
    const target = { wrapper: frozen };
    const proxy = createDeepProxy(target);

    expect(proxy.wrapper).toBe(frozen);
    expect(proxy.wrapper.inner.a).toBe(1);
  });

  it("returns the raw value for non-writable non-configurable properties", () => {
    const inner = { a: 1 };
    const target: { locked?: { a: number } } = {};
    Object.defineProperty(target, "locked", {
      value: inner,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    const proxy = createDeepProxy(target);

    expect(proxy.locked).toBe(inner);
  });

  it("returns a mutable own compound array method without wrapping it", () => {
    const values = [1];
    Object.defineProperty(values, "push", {
      value: Array.prototype.push,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    const arrayMethodComplete = mock();
    const proxy = createDeepProxy(values, { callbacks: { arrayMethodComplete } });

    expect(proxy.push).toBe(Array.prototype.push);
    expect(proxy.push(2)).toBe(2);
    expect(values).toEqual([1, 2]);
    expect(arrayMethodComplete).not.toHaveBeenCalled();
  });

  it("keeps sealed objects reactive", () => {
    const callbacks: Partial<ProxyCallbacks> = { set: mock() };
    const target = { sealed: Object.seal({ a: 1 }) };
    const proxy = createDeepProxy(target, { callbacks });

    proxy.sealed.a = 2;

    expect(target.sealed.a).toBe(2);
    expect(callbacks.set).toHaveBeenCalledTimes(1);
  });
});

describe("trap edge cases", () => {
  it("does not report a cached read when the live descriptor check throws", () => {
    const child = {};
    let throwOnDescriptorRead = false;
    const nested = new Proxy(
      { child },
      {
        getOwnPropertyDescriptor(target, prop) {
          if (throwOnDescriptorRead && prop === "child") throw new Error("descriptor read failed");
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );
    const reads: (string | symbol)[] = [];
    const proxy = createDeepProxy({ nested }, { callbacks: { get: (_target, prop) => reads.push(prop) } });
    expect(proxy.nested.child).not.toBe(child);
    reads.length = 0;
    throwOnDescriptorRead = true;

    expect(() => proxy.nested.child).toThrow("descriptor read failed");
    expect(reads).toEqual(["nested"]);
  });

  it("returns raw for a property locked after its child proxy was cached", () => {
    const target: { child: { v: number } } = { child: { v: 1 } };
    const proxy = createDeepProxy(target);
    const wrappedBefore = proxy.child;
    expect(wrappedBefore.v).toBe(1);

    Object.defineProperty(target, "child", {
      value: target.child,
      writable: false,
      configurable: false,
      enumerable: true,
    });

    const after = proxy.child;
    expect(after).toBe(target.child);
    expect(after.v).toBe(1);
  });

  it("reports only successful deletes", () => {
    const callbacks: Partial<ProxyCallbacks> = { deleteProperty: mock() };
    const target: { removable?: number; locked?: number } = { removable: 1 };
    Object.defineProperty(target, "locked", {
      value: 1,
      writable: true,
      configurable: false,
      enumerable: true,
    });
    const proxy = createDeepProxy(target, { callbacks });

    expect(Reflect.deleteProperty(proxy, "locked")).toBe(false);
    expect(callbacks.deleteProperty).toHaveBeenCalledTimes(0);

    expect(Reflect.deleteProperty(proxy, "missing")).toBe(true);
    expect(callbacks.deleteProperty).toHaveBeenCalledTimes(0);

    expect(Reflect.deleteProperty(proxy, "removable")).toBe(true);
    expect(callbacks.deleteProperty).toHaveBeenCalledTimes(1);
    expect(callbacks.deleteProperty).toHaveBeenCalledWith(target, "removable", 1);
  });

  it("reports accessor and data descriptors", () => {
    const callbacks: Partial<ProxyCallbacks> = { defineProperty: mock() };
    const getter = mock(() => 1);
    const target: { accessor?: number; data?: number } = {};
    const proxy = createDeepProxy(target, { callbacks });

    Object.defineProperty(proxy, "accessor", { get: getter, configurable: true, enumerable: true });
    Object.defineProperty(proxy, "data", {
      value: 5,
      configurable: true,
      enumerable: true,
      writable: true,
    });

    expect(getter).not.toHaveBeenCalled();
    expect(callbacks.defineProperty).toHaveBeenCalledTimes(2);
    expect(callbacks.defineProperty).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target,
        prop: "accessor",
        before: undefined,
        after: expect.objectContaining({ get: getter }),
      }),
    );
    expect(callbacks.defineProperty).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target,
        prop: "data",
        before: undefined,
        after: expect.objectContaining({ value: 5 }),
      }),
    );
  });
});

describe("mutation deltas", () => {
  it("preserves nested user-Proxy descriptor effects before set", () => {
    let descriptorReads = 0;
    let setCalls = 0;
    const raw = { value: 1 };
    const nested = new Proxy(raw, {
      getOwnPropertyDescriptor(target, prop) {
        descriptorReads++;
        if (descriptorReads === 2) throw new Error("descriptor read failed");
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      set(target, prop, value, receiver) {
        setCalls++;
        return Reflect.set(target, prop, value, receiver);
      },
    });
    const proxy = createDeepProxy({ nested });

    expect(() => {
      proxy.nested.value = 2;
    }).toThrow("descriptor read failed");
    expect(setCalls).toBe(0);
    expect(raw.value).toBe(1);
  });

  it("preserves nested user-Proxy descriptor effects during receiver definition", () => {
    let insideSet = false;
    let descriptorReadsInsideSet = 0;
    const raw = { value: 1 };
    const nested = new Proxy(raw, {
      set(target, prop, value, receiver) {
        insideSet = true;
        try {
          return Reflect.set(target, prop, value, receiver);
        } finally {
          insideSet = false;
        }
      },
      getOwnPropertyDescriptor(target, prop) {
        if (insideSet) {
          descriptorReadsInsideSet++;
          if (descriptorReadsInsideSet === 2) throw new Error("descriptor read failed");
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const proxy = createDeepProxy({ nested });

    expect(() => {
      proxy.nested.value = 2;
    }).toThrow("descriptor read failed");
    expect(raw.value).toBe(1);
  });

  it("preserves same-value and changed writes through nested user proxies", () => {
    const receivers: unknown[] = [];
    const nested = new Proxy(
      { value: 1 },
      {
        set(target, prop, value, receiver) {
          receivers.push(receiver);
          return Reflect.set(target, prop, value);
        },
      },
    );
    const proxy = createDeepProxy({ nested });
    const nestedProxy = proxy.nested;

    nestedProxy.value = 1;
    nestedProxy.value = 2;

    expect(receivers).toEqual([nestedProxy, nestedProxy]);
    expect(nested.value).toBe(2);
  });

  it("reports the effective result of a transformed same-value write", () => {
    const set = mock();
    const raw = { value: 1 };
    const nested = new Proxy(raw, {
      set(target, prop) {
        return Reflect.set(target, prop, 2);
      },
    });
    const proxy = createDeepProxy({ nested }, { callbacks: { set } });

    proxy.nested.value = 1;

    expect(raw.value).toBe(2);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ target: nested, prop: "value", oldValue: 1, value: 2 }),
    );
  });

  it("executes same-payload setters with the proxy receiver", () => {
    let calls = 0;
    const receivers: unknown[] = [];
    const prototype: { value?: number } = Object.create(null);
    Object.defineProperty(prototype, "value", {
      configurable: true,
      set(this: unknown) {
        calls++;
        receivers.push(this);
      },
    });
    const target: { value: number } = Object.create(prototype);
    const proxy = createDeepProxy(target);

    proxy.value = 1;

    expect(calls).toBe(1);
    expect(receivers).toEqual([proxy]);
  });

  it("executes same-payload accessors on the owned root", () => {
    let calls = 0;
    const receivers: unknown[] = [];
    const source = {
      get value() {
        return 1;
      },
      set value(_value: number) {
        calls++;
        receivers.push(this);
      },
    };
    const proxy = createRootProxy(() => source);

    proxy.value = 1;

    expect(calls).toBe(1);
    expect(receivers).toEqual([proxy]);
  });

  it("preserves failed same-value writes on the owned root", () => {
    const source: { value?: number } = {};
    Object.defineProperty(source, "value", {
      value: 1,
      configurable: true,
      enumerable: true,
      writable: false,
    });
    const proxy = createRootProxy(() => source);

    expect(Reflect.set(proxy, "value", 1)).toBe(false);
  });

  it("preserves a writable root descriptor and reports one changed write", () => {
    const set = mock();
    const defineProperty = mock();
    const source: { value?: number } = {};
    Object.defineProperty(source, "value", {
      value: 1,
      configurable: false,
      enumerable: false,
      writable: true,
    });
    const proxy = createRootProxy(() => source, { callbacks: { set, defineProperty } });

    proxy.value = 2;

    expect(Object.getOwnPropertyDescriptor(proxy, "value")).toEqual({
      value: 2,
      configurable: false,
      enumerable: false,
      writable: true,
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ prop: "value", oldValue: 1, value: 2 }));
    expect(defineProperty).not.toHaveBeenCalled();
  });

  it("applies same-value writes to a noncanonical receiver", () => {
    const proxy = createRootProxy(() => ({ value: 1 }));
    const receiver: { value?: number } = {};

    expect(Reflect.set(proxy, "value", 1, receiver)).toBe(true);

    expect(receiver).toEqual({ value: 1 });
  });

  it("does not report failed sets", () => {
    const set = mock();
    const target = Object.preventExtensions({ fixed: 1 });
    Object.defineProperty(target, "fixed", { writable: false });
    const proxy = createDeepProxy(target, { callbacks: { set } });

    expect(Reflect.set(proxy, "fixed", 2)).toBe(false);
    expect(Reflect.set(proxy, "newKey", 1)).toBe(false);

    expect(set).not.toHaveBeenCalled();
  });

  it("reports implicit array length growth in the set delta", () => {
    const set = mock();
    const target = [1];
    const proxy = createDeepProxy(target, { callbacks: { set } });

    proxy[3] = 4;

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ target, prop: "3", oldArrayLength: 1, newArrayLength: 4 }),
    );
  });

  it("suppresses only the receiver definition owned by the active set", () => {
    const set = mock();
    const defineProperty = mock();
    const target: { value?: number; nested?: number } = {};
    Object.defineProperty(target, "value", {
      configurable: true,
      set(this: typeof target) {
        Object.defineProperty(this, "nested", {
          value: 2,
          configurable: true,
          enumerable: true,
          writable: true,
        });
      },
    });
    const proxy = createDeepProxy(target, { callbacks: { set, defineProperty } });

    proxy.value = 1;

    expect(set).toHaveBeenCalledTimes(1);
    expect(defineProperty).toHaveBeenCalledTimes(1);
    expect(defineProperty).toHaveBeenCalledWith(expect.objectContaining({ target, prop: "nested" }));
  });

  it("restores descriptor reporting after a setter throws", () => {
    const defineProperty = mock();
    const target: { value?: number; after?: number } = {};
    Object.defineProperty(target, "value", {
      configurable: true,
      set() {
        throw new Error("setter failed");
      },
    });
    const proxy = createDeepProxy(target, { callbacks: { defineProperty } });

    expect(() => Reflect.set(proxy, "value", 1)).toThrow("setter failed");
    Object.defineProperty(proxy, "after", { value: 2, configurable: true, enumerable: true, writable: true });

    expect(defineProperty).toHaveBeenCalledTimes(1);
    expect(defineProperty).toHaveBeenCalledWith(expect.objectContaining({ target, prop: "after" }));
  });

  it("does not report an equivalent effective descriptor", () => {
    const defineProperty = mock();
    const target = { value: 1 };
    const proxy = createDeepProxy(target, { callbacks: { defineProperty } });

    Object.defineProperty(proxy, "value", {
      value: 1,
      configurable: true,
      enumerable: true,
      writable: true,
    });

    expect(defineProperty).not.toHaveBeenCalled();
  });
});

describe("compound array ownership", () => {
  it("reports sibling mutations normally while an array method is active", () => {
    const set = mock();
    const arrayMethodComplete = mock();
    const target = { items: [2, 1], status: "idle" };
    const proxy = createDeepProxy(target, { callbacks: { set, arrayMethodComplete } });

    proxy.items.sort((left, right) => {
      proxy.status = "sorting";
      return left - right;
    });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ target, prop: "status", value: "sorting" }));
    expect(arrayMethodComplete).toHaveBeenCalledWith(
      target.items,
      "sort",
      expect.objectContaining({ coarse: false, mayDetachElements: true, ops: expect.any(Array) }),
    );
  });

  it("attributes a borrowed method to its proxied receiver", () => {
    const arrayMethodComplete = mock();
    const target: { source: number[]; receiver: number[] } = { source: [], receiver: [] };
    const proxy = createDeepProxy(target, { callbacks: { arrayMethodComplete } });
    const push = proxy.source.push;

    push.call(proxy.receiver, 1);

    expect(target.receiver).toEqual([1]);
    expect(arrayMethodComplete).toHaveBeenCalledWith(
      target.receiver,
      "push",
      expect.objectContaining({ coarse: false, mayDetachElements: true, ops: expect.any(Array) }),
    );
    expect(arrayMethodComplete).not.toHaveBeenCalledWith(target.source, "push", expect.anything());
  });

  it("does not attribute borrowed methods to foreign receivers", () => {
    const ownerComplete = mock();
    const receiverSet = mock();
    const ownerTarget: { source: number[] } = { source: [] };
    const receiverTarget: { items: number[] } = { items: [] };
    const owner = createDeepProxy(ownerTarget, { callbacks: { arrayMethodComplete: ownerComplete } });
    const receiver = createDeepProxy(receiverTarget, { callbacks: { set: receiverSet } });
    const rawReceiver: number[] = [];
    const push = owner.source.push;

    push.call(receiver.items, 1);
    push.call(rawReceiver, 2);

    expect(receiver.items).toEqual([1]);
    expect(rawReceiver).toEqual([2]);
    expect(receiverSet).toHaveBeenCalledTimes(1);
    expect(ownerComplete).not.toHaveBeenCalled();
  });

  it("preserves array length sampling when assigned-value unwrapping reenters push", () => {
    const completions: CompoundCompletion[] = [];
    const target: { list: unknown[] } = { list: [] };
    const proxy = createDeepProxy(target, {
      unwrapSet: true,
      callbacks: {
        arrayMethodComplete: (_target, _method, completion) => {
          completions.push(completion);
        },
      },
    });
    const insertedTarget = {};
    const insertedProxy = createDeepProxy(insertedTarget);
    let reentered = false;
    const inserted = new Proxy(insertedProxy, {
      get(value, prop, receiver) {
        if (prop === UNWRAP_PROXY_KEY && !reentered) {
          reentered = true;
          proxy.list.push("reentrant");
        }
        return Reflect.get(value, prop, receiver);
      },
    });

    proxy.list.push(inserted);

    expect(target.list).toEqual([insertedTarget]);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.ops).toEqual([
      { type: "set", prop: "0", isNewProperty: true },
      { type: "set", prop: "length", isNewProperty: false },
    ]);
  });

  it("reports effective compound writes through a nested user Proxy", () => {
    const defineProperty = mock();
    const completions: CompoundCompletion[] = [];
    const raw: number[] & { redirected?: number } = [];
    const nested = new Proxy(raw, {
      set(target, prop, value, receiver) {
        const effectiveProp = prop === "0" ? "redirected" : prop;
        return Reflect.set(target, effectiveProp, value, receiver);
      },
    });
    const proxy = createDeepProxy(
      { list: nested },
      {
        callbacks: {
          defineProperty,
          arrayMethodComplete: (_target, _method, completion) => {
            completions.push(completion);
          },
        },
      },
    );

    proxy.list.push(1);

    expect(Object.hasOwn(raw, 0)).toBe(false);
    expect(raw.redirected).toBe(1);
    expect(raw).toHaveLength(1);
    expect(defineProperty).toHaveBeenCalledWith(
      expect.objectContaining({ target: nested, prop: "redirected" }),
    );
    expect(completions[0]?.ops).toEqual([{ type: "set", prop: "length", isNewProperty: false }]);
  });

  it("merges nested work on the same array and preserves different-array work", () => {
    const sameComplete = mock();
    const sameTarget = { items: [2, 1] };
    const sameProxy = createDeepProxy(sameTarget, { callbacks: { arrayMethodComplete: sameComplete } });
    let pushedSame = false;
    sameProxy.items.sort((left, right) => {
      if (!pushedSame) {
        pushedSame = true;
        sameProxy.items.push(3);
      }
      return left - right;
    });
    expect(sameComplete).toHaveBeenCalledTimes(1);
    expect(sameComplete).toHaveBeenCalledWith(
      sameTarget.items,
      "sort",
      expect.objectContaining({ mayDetachElements: true, ops: expect.any(Array) }),
    );

    const differentComplete = mock();
    const differentTarget: { left: number[]; right: number[] } = { left: [2, 1], right: [] };
    const differentProxy = createDeepProxy(differentTarget, {
      callbacks: { arrayMethodComplete: differentComplete },
    });
    let pushedDifferent = false;
    differentProxy.left.sort((left, right) => {
      if (!pushedDifferent) {
        pushedDifferent = true;
        differentProxy.right.push(3);
      }
      return left - right;
    });
    expect(differentComplete).toHaveBeenCalledTimes(2);
    expect(differentComplete).toHaveBeenCalledWith(
      differentTarget.right,
      "push",
      expect.objectContaining({ mayDetachElements: true, ops: expect.any(Array) }),
    );
    expect(differentComplete).toHaveBeenCalledWith(
      differentTarget.left,
      "sort",
      expect.objectContaining({ mayDetachElements: true, ops: expect.any(Array) }),
    );
  });

  it("restores the compound context after a callback exception", () => {
    const arrayMethodComplete = mock();
    const target: { failing: number[]; later: number[] } = { failing: [2, 1], later: [] };
    const proxy = createDeepProxy(target, { callbacks: { arrayMethodComplete } });

    expect(() =>
      proxy.failing.sort(() => {
        throw new Error("compare failed");
      }),
    ).toThrow("compare failed");
    proxy.later.push(1);

    expect(arrayMethodComplete).toHaveBeenLastCalledWith(
      target.later,
      "push",
      expect.objectContaining({ coarse: false, mayDetachElements: true, ops: expect.any(Array) }),
    );
  });

  it("marks the completion coarse past 32 deduped ops and stops materializing them", () => {
    const completions: CompoundCompletion[] = [];
    const arrayMethodComplete = (_target: unknown[], _method: string, completion: CompoundCompletion) => {
      completions.push(completion);
    };
    const coarseTarget = { list: Array.from({ length: 40 }, (_, index) => index) };
    const coarseProxy = createDeepProxy(coarseTarget, { callbacks: { arrayMethodComplete } });
    coarseProxy.list.splice(0, 0, -1);
    expect(completions).toEqual([{ coarse: true, ops: [], mayDetachElements: true }]);

    const preciseTarget = { list: Array.from({ length: 30 }, (_, index) => index) };
    const preciseProxy = createDeepProxy(preciseTarget, { callbacks: { arrayMethodComplete } });
    preciseProxy.list.splice(0, 0, -1);
    const precise = completions[1];
    if (precise === undefined) throw new Error("the precise splice never completed");
    expect(precise.coarse).toBe(false);
    expect(precise.ops).toHaveLength(32);
  });

  it("marks a shrink splice coarse from its guaranteed delete count alone", () => {
    const arrayMethodComplete = mock();
    const target = { list: Array.from({ length: 80 }, (_, index) => index) };
    const proxy = createDeepProxy(target, { callbacks: { arrayMethodComplete } });

    proxy.list.splice(0, 40);
    expect(target.list).toHaveLength(40);
    expect(target.list[0]).toBe(40);
    expect(arrayMethodComplete).toHaveBeenCalledWith(
      target.list,
      "splice",
      expect.objectContaining({ coarse: true, ops: [], mayDetachElements: true }),
    );
  });

  it("keeps a sparse shrink splice precise despite a nominal delete count over the threshold", () => {
    const completions: CompoundCompletion[] = [];
    const arrayMethodComplete = (_target: unknown[], _method: string, completion: CompoundCompletion) => {
      completions.push(completion);
    };
    const sparse: number[] = [];
    sparse[79] = 1;
    const target = { list: sparse };
    const proxy = createDeepProxy(target, { callbacks: { arrayMethodComplete } });

    proxy.list.splice(0, 40);
    expect(target.list).toHaveLength(40);
    expect(target.list[39]).toBe(1);
    const completion = completions[0];
    if (completion === undefined) throw new Error("the sparse splice never completed");
    expect(completion.coarse).toBe(false);
    expect(completion.ops.length).toBeGreaterThan(0);
    expect(completion.ops.length).toBeLessThanOrEqual(32);
  });

  it("reports partial splice work when insertion unwrapping throws", () => {
    const completions: CompoundCompletion[] = [];
    const arrayMethodComplete = (_target: unknown[], _method: string, completion: CompoundCompletion) => {
      completions.push(completion);
    };
    const target: { list: unknown[] } = { list: Array.from({ length: 80 }, (_, index) => index) };
    const proxy = createDeepProxy(target, { unwrapSet: true, callbacks: { arrayMethodComplete } });
    const throwing = new Proxy(
      {},
      {
        get: () => {
          throw new Error("unwrap failed");
        },
      },
    );

    expect(() => proxy.list.splice(0, 40, throwing)).toThrow("unwrap failed");
    expect(target.list).toHaveLength(80);
    expect(target.list[0]).toBe(0);
    expect(target.list[1]).toBe(40);
    expect(Object.hasOwn(target.list, 79)).toBe(false);
    expect(completions).toEqual([{ coarse: true, ops: [], mayDetachElements: true }]);
  });
});

describe("opaque values and deep unwrapping", () => {
  it("keeps URL values raw and rejects them consistently in strict mode", () => {
    const url = new URL("https://example.com/path");
    const search = new URLSearchParams("page=1");
    const proxy = createDeepProxy({ url, search });
    const strict = createDeepProxy({ url, search }, { strict: true });

    expect(proxy.url).toBe(url);
    expect(proxy.url.pathname).toBe("/path");
    expect(proxy.search).toBe(search);
    expect(proxy.search.get("page")).toBe("1");
    expect(() => strict.url).toThrow(/strict mode rejects URL/);
    expect(() => strict.search).toThrow(/strict mode rejects URLSearchParams/);
  });

  it("keeps URL values created by another browser realm raw", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      const realmWindow = frame.contentWindow;
      const RealmURL = realmWindow ? Reflect.get(realmWindow, "URL") : undefined;
      const RealmURLSearchParams = realmWindow ? Reflect.get(realmWindow, "URLSearchParams") : undefined;
      if (typeof RealmURL !== "function" || typeof RealmURLSearchParams !== "function") {
        throw new TypeError("iframe URL constructors are unavailable");
      }
      const url: unknown = Reflect.construct(RealmURL, ["https://example.com/cross-realm"]);
      const search: unknown = Reflect.construct(RealmURLSearchParams, ["page=2"]);
      if (typeof url !== "object" || url === null || typeof search !== "object" || search === null) {
        throw new Error("iframe URL construction failed");
      }
      const proxy = createDeepProxy({ url, search });
      const strict = createDeepProxy({ url, search }, { strict: true });

      expect(proxy.url).toBe(url);
      expect(Reflect.get(proxy.url, "pathname")).toBe("/cross-realm");
      expect(proxy.search).toBe(search);
      const searchGet: unknown = Reflect.get(proxy.search, "get");
      if (typeof searchGet !== "function") throw new Error("iframe URLSearchParams.get is unavailable");
      expect(Reflect.apply(searchGet, proxy.search, ["page"])).toBe("2");
      expect(() => strict.url).toThrow(/strict mode rejects URL/);
      expect(() => strict.search).toThrow(/strict mode rejects URLSearchParams/);
    } finally {
      frame.remove();
    }
  });

  it("keeps supported cross-realm built-ins raw", () => {
    const realmResult: unknown = runInNewContext(
      "[new Map([['a', 1]]), new Set([1]), new WeakMap(), new WeakSet(), new Date(0), /x/, new ArrayBuffer(4), new Uint8Array([1]), Promise.resolve(1)]",
    );
    if (!Array.isArray(realmResult)) throw new Error("cross-realm fixture did not return an array");

    for (const value of realmResult) {
      const proxy = createDeepProxy({ value });
      const strict = createDeepProxy({ value }, { strict: true });
      expect(proxy.value).toBe(value);
      expect(() => strict.value).toThrow(/strict mode rejects/);
    }
  });

  it("does not mistake spoofed built-in tags for internal slots", () => {
    class TaggedRecord {
      nested = { count: 0 };
    }
    Object.defineProperty(TaggedRecord.prototype, Symbol.toStringTag, {
      configurable: true,
      get: () => "Map",
    });

    const value = new TaggedRecord();
    const set = mock();
    const proxy = createDeepProxy({ value }, { callbacks: { set }, strict: true });

    expect(opaqueObjectType(value)).toBeNull();
    expect(opaqueObjectType(new Map())).toBe("Map");
    expect(proxy.value).not.toBe(value);
    proxy.value.nested.count = 1;

    const promiseTagged = { nested: { count: 0 }, [Symbol.toStringTag]: "Promise" };
    const promiseProxy = createDeepProxy({ value: promiseTagged }, { callbacks: { set }, strict: true });
    expect(promiseProxy.value).not.toBe(promiseTagged);
    promiseProxy.value.nested.count = 1;

    expect(set).toHaveBeenCalledTimes(2);
  });

  it("preserves opaque values, cycles, aliases, and own __proto__ data", () => {
    const date = new Date("2024-01-01");
    const frozen = Object.freeze({ stable: true });
    const target: {
      self?: unknown;
      left: { value: number };
      right: { value: number };
      date: Date;
      frozen: Readonly<{ stable: boolean }>;
    } = {
      left: { value: 1 },
      right: { value: 1 },
      date,
      frozen,
    };
    target.right = target.left;
    target.self = target;
    Object.defineProperty(target, "__proto__", {
      value: { safe: true },
      configurable: true,
      enumerable: true,
      writable: true,
    });

    const result = unwrapDeepProxy(createDeepProxy(target));

    expect(result.self).toBe(result);
    expect(result.left).toBe(result.right);
    expect(result.date).toBe(date);
    expect(result.frozen).toEqual(frozen);
    expect(result.frozen).not.toBe(frozen);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
