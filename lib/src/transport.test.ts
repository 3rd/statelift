import { describe, expect, it, mock } from "bun:test";
import type { ProxyMap, ProxySet } from "./collections";
import type { DeepPartial, Dehydrated } from "./store";
import { proxyMap, proxySet } from "./collections";
import { unwrapProxy } from "./proxy";
import { createStore, dehydrate, hydrate, snapshot, subscribe } from "./store";
import {
  createTransportPreview,
  decodeTransportEnvelope,
  encodeDevtoolsGraph,
  encodeTransportEnvelope,
} from "./transport";

describe("transport graph codec", () => {
  it("round-trips cycles and aliases through JSON and hydration", () => {
    type Node = { value: number };
    type GraphState = {
      self: unknown;
      left: Node;
      right: Node;
      links: unknown[];
    };
    const shared = { value: 7 };
    const server = createStore<GraphState>({
      self: null,
      left: shared,
      right: shared,
      links: [],
    });
    server.state.self = server.state;
    server.state.links.push(server.state, server.state.left);
    const transferred: unknown = JSON.parse(JSON.stringify(dehydrate(server)));
    const client = createStore<GraphState>({
      self: null,
      left: { value: 0 },
      right: { value: 0 },
      links: [],
    });

    hydrate(client, transferred, {
      validate: (data) => typeof data === "object" && data !== null && Reflect.has(data, "left"),
    });

    if (typeof client.state.self !== "object" || client.state.self === null) {
      throw new Error("transport did not restore the root cycle");
    }
    const root = unwrapProxy(client.state, true);
    const rootLink = client.state.links[0];
    const sharedLink = client.state.links[1];
    if (
      typeof rootLink !== "object" ||
      rootLink === null ||
      typeof sharedLink !== "object" ||
      sharedLink === null
    ) {
      throw new Error("transport links are missing");
    }
    expect(unwrapProxy(client.state.self, true)).toBe(root);
    expect(unwrapProxy(client.state.left, true)).toBe(unwrapProxy(client.state.right, true));
    expect(unwrapProxy(rootLink, true)).toBe(root);
    expect(unwrapProxy(sharedLink, true)).toBe(unwrapProxy(client.state.left, true));
  });

  it("preserves supported built-ins, symbols, property enumerability, and buffer aliases", () => {
    const globalKey = Symbol.for("statelift.transport.test");
    const shared = { value: 1 };
    Object.defineProperty(shared, "hidden", {
      value: "kept",
      configurable: false,
      enumerable: false,
      writable: false,
    });
    const buffer = new ArrayBuffer(4);
    const view = new Uint16Array(buffer);
    view[0] = 513;
    const source = {
      shared,
      nativeMap: new Map<unknown, unknown>([[shared, shared]]),
      nativeSet: new Set<unknown>([shared]),
      date: new Date("2025-01-02T03:04:05.000Z"),
      regexp: /a+b/giu,
      buffer,
      view,
      url: new URL("https://example.com/a?b=1"),
      params: new URLSearchParams("a=1&b=2"),
      bigint: 123n,
      missing: undefined,
      notANumber: Number.NaN,
    };
    source.regexp.lastIndex = 3;
    Object.defineProperty(source, globalKey, {
      value: shared,
      configurable: true,
      enumerable: true,
      writable: true,
    });

    const encoded = encodeTransportEnvelope(snapshot(createStore(source)));
    const decoded = decodeTransportEnvelope(JSON.parse(JSON.stringify(encoded)));
    if (decoded === null || typeof decoded !== "object") throw new Error("decoded graph is not an object");

    const decodedShared = Reflect.get(decoded, "shared");
    const decodedMap = Reflect.get(decoded, "nativeMap");
    const decodedSet = Reflect.get(decoded, "nativeSet");
    const decodedBuffer = Reflect.get(decoded, "buffer");
    const decodedView = Reflect.get(decoded, "view");
    const decodedDate = Reflect.get(decoded, "date");
    const decodedRegExp = Reflect.get(decoded, "regexp");
    const decodedUrl = Reflect.get(decoded, "url");
    const decodedParams = Reflect.get(decoded, "params");

    expect(decodedMap).toBeInstanceOf(Map);
    expect(decodedSet).toBeInstanceOf(Set);
    if (!(decodedMap instanceof Map) || !(decodedSet instanceof Set)) {
      throw new TypeError("decoded collections have the wrong runtime type");
    }
    expect([...decodedMap.keys()][0]).toBe(decodedShared);
    expect([...decodedMap.values()][0]).toBe(decodedShared);
    expect([...decodedSet][0]).toBe(decodedShared);
    expect(Reflect.get(decoded, globalKey)).toBe(decodedShared);
    expect(Reflect.get(decodedShared, "hidden")).toBe("kept");
    expect(Object.getOwnPropertyDescriptor(decodedShared, "hidden")).toEqual({
      value: "kept",
      configurable: true,
      enumerable: false,
      writable: true,
    });
    expect(decodedDate).toBeInstanceOf(Date);
    expect(decodedDate instanceof Date ? decodedDate.toISOString() : "").toBe("2025-01-02T03:04:05.000Z");
    expect(decodedRegExp).toBeInstanceOf(RegExp);
    expect(decodedRegExp instanceof RegExp ? decodedRegExp.lastIndex : -1).toBe(3);
    expect(decodedBuffer).toBeInstanceOf(ArrayBuffer);
    expect(decodedView).toBeInstanceOf(Uint16Array);
    if (!(decodedView instanceof Uint16Array)) throw new Error("decoded view has the wrong runtime type");
    expect(decodedView.buffer).toBe(decodedBuffer);
    expect(decodedView[0]).toBe(513);
    expect(decodedUrl instanceof URL ? decodedUrl.href : "").toBe("https://example.com/a?b=1");
    expect(decodedParams instanceof URLSearchParams ? decodedParams.toString() : "").toBe("a=1&b=2");
    expect(Reflect.get(decoded, "bigint")).toBe(123n);
    expect(Reflect.has(decoded, "missing")).toBe(true);
    expect(Reflect.get(decoded, "missing")).toBeUndefined();
    expect(Number.isNaN(Reflect.get(decoded, "notANumber"))).toBe(true);
  });

  it("round-trips plain records whose tags name built-ins", () => {
    for (const tag of ["Map", "Set"]) {
      const source = { [Symbol.toStringTag]: tag, value: 1 };
      const encoded = encodeTransportEnvelope(source);
      const decoded = decodeTransportEnvelope(JSON.parse(JSON.stringify(encoded)));
      if (typeof decoded !== "object" || decoded === null) {
        throw new Error("decoded tagged record is not an object");
      }
      expect(Reflect.get(decoded, Symbol.toStringTag)).toBe(tag);
      expect(Reflect.get(decoded, "value")).toBe(1);
      const preview = createTransportPreview(source);
      if (typeof preview !== "object" || preview === null) {
        throw new Error("tagged record preview is not an object");
      }
      expect(Reflect.get(preview, "value")).toBe(1);
    }
  });

  it("round-trips every numeric RegExp lastIndex through JSON", () => {
    for (const lastIndex of [-1, 1.5, Number.NaN, Infinity, -Infinity, -0]) {
      const source = /x/g;
      source.lastIndex = lastIndex;
      const encoded = encodeTransportEnvelope(source);
      const decoded = decodeTransportEnvelope(JSON.parse(JSON.stringify(encoded)));
      if (!(decoded instanceof RegExp)) throw new Error("decoded value is not a RegExp");
      expect(Object.is(decoded.lastIndex, lastIndex)).toBe(true);
    }
  });

  it("keeps reactive and native collections distinct after hydration", () => {
    const server = createStore({
      reactiveMap: proxyMap<string, number>([["a", 1]]),
      reactiveSet: proxySet(["x"]),
      nativeMap: new Map([["b", 2]]),
      nativeSet: new Set(["y"]),
    });
    const client = createStore({
      reactiveMap: proxyMap<string, number>(),
      reactiveSet: proxySet<string>(),
      nativeMap: new Map<string, number>(),
      nativeSet: new Set<string>(),
    });

    hydrate(client, dehydrate(server));

    expect(client.state.reactiveMap.get("a")).toBe(1);
    expect(client.state.reactiveSet.has("x")).toBe(true);
    expect(client.state.nativeMap).toBeInstanceOf(Map);
    expect(client.state.nativeMap.get("b")).toBe(2);
    expect(client.state.nativeSet).toBeInstanceOf(Set);
    expect(client.state.nativeSet.has("y")).toBe(true);
  });

  it("creates reactive collections when hydrated collection slots are missing", () => {
    type State = {
      items?: ProxyMap<string, number>;
      tags?: ProxySet<string>;
    };
    const server = createStore<State>({
      items: proxyMap([["a", 1]]),
      tags: proxySet(["x"]),
    });
    const client = createStore<State>({});

    hydrate(client, dehydrate(server));

    const items = client.state.items;
    const tags = client.state.tags;
    if (items === undefined || tags === undefined) {
      throw new Error("hydrated reactive collections are missing");
    }
    expect(items instanceof Map).toBe(false);
    expect(tags instanceof Set).toBe(false);
    expect(items.get("a")).toBe(1);
    expect(tags.has("x")).toBe(true);

    const onMapChange = mock();
    const onSetChange = mock();
    const unsubscribeMap = subscribe(client, (state) => state.items?.get("b"), onMapChange);
    const unsubscribeSet = subscribe(client, (state) => state.tags?.has("y"), onSetChange);
    items.set("b", 2);
    tags.add("y");

    expect(onMapChange).toHaveBeenCalledTimes(1);
    expect(onSetChange).toHaveBeenCalledTimes(1);
    unsubscribeMap();
    unsubscribeSet();
  });

  it("preserves aliases between collection members and ordinary state during hydration", () => {
    type Shared = { value: number };
    const shared: Shared = { value: 7 };
    const server = createStore({
      nativeMap: new Map([[shared, shared]]),
      reactiveMap: proxyMap([[shared, shared]]),
      nativeSet: new Set([shared]),
      reactiveSet: proxySet([shared]),
      shared,
    });
    const client = createStore({
      nativeMap: new Map<Shared, Shared>(),
      reactiveMap: proxyMap<Shared, Shared>(),
      nativeSet: new Set<Shared>(),
      reactiveSet: proxySet<Shared>(),
      shared: { value: 0 },
    });

    hydrate(client, dehydrate(server));

    const expected = unwrapProxy(client.state.shared, true);
    const nativeMapEntry = [...client.state.nativeMap][0];
    const reactiveMapEntry = [...client.state.reactiveMap][0];
    const nativeSetEntry = [...client.state.nativeSet][0];
    const reactiveSetEntry = [...client.state.reactiveSet][0];
    if (
      nativeMapEntry === undefined ||
      reactiveMapEntry === undefined ||
      nativeSetEntry === undefined ||
      reactiveSetEntry === undefined
    ) {
      throw new Error("hydrated collection aliases are missing");
    }

    expect(unwrapProxy(nativeMapEntry[0], true)).toBe(expected);
    expect(unwrapProxy(nativeMapEntry[1], true)).toBe(expected);
    expect(unwrapProxy(reactiveMapEntry[0], true)).toBe(expected);
    expect(unwrapProxy(reactiveMapEntry[1], true)).toBe(expected);
    expect(unwrapProxy(nativeSetEntry, true)).toBe(expected);
    expect(unwrapProxy(reactiveSetEntry, true)).toBe(expected);
    expect(client.state.shared.value).toBe(7);
  });

  it("rejects malformed input before mutating the store", () => {
    const store = createStore({ n: 1 });
    const listener = mock();
    const unsubscribe = subscribe(store, listener);
    const malformed: unknown = 'statelift:1:{"format":"statelift","version":1,"root":["ref",9],"nodes":[]}';

    expect(() => hydrate(store, malformed, { validate: () => true })).toThrow(/reference/);
    expect(store.state.n).toBe(1);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("rejects reactive collection members with functions or accessors", () => {
    const item = {
      value: 1,
      increment() {
        this.value++;
      },
      get double() {
        return this.value * 2;
      },
    };
    const mapStore = createStore({ items: proxyMap([["item", item]]) });
    const nestedSetStore = createStore({ items: proxySet([{ nested: item }]) });

    expect(() => dehydrate(mapStore)).toThrow(/reactive collection member with actions or accessors/);
    expect(() => dehydrate(nestedSetStore)).toThrow(/reactive collection member with actions or accessors/);
  });

  it("rejects mutable class instances before their prototype can be flattened", () => {
    class Box {
      value = 1;

      increment() {
        this.value++;
      }
    }

    expect(() => dehydrate(createStore({ box: new Box() }))).toThrow(/unsupported class instance \(Box\)/);
  });

  it("rejects custom properties on typed arrays instead of silently dropping them", () => {
    const bytes = new Uint8Array([1, 2]);
    Object.defineProperty(bytes, "label", {
      value: "important",
      configurable: true,
      enumerable: true,
      writable: true,
    });

    expect(() => dehydrate(createStore({ bytes }))).toThrow(/custom built-in property/);
  });

  it("wraps constructor errors as boundary errors and retains the cause", () => {
    const envelope = {
      format: "statelift",
      version: 1,
      root: ["ref", 0],
      nodes: [["regexp", "(", "", 0]],
    };
    let caught: unknown;
    try {
      decodeTransportEnvelope(JSON.parse(JSON.stringify(envelope)));
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof TypeError)) throw new Error("expected the boundary TypeError");
    expect(caught.message).toBe("statelift: malformed dehydrated payload");
    expect(caught.cause).toBeDefined();
  });
});

describe("devtools graph encoder", () => {
  it("flags reactive collection entries whose origins carry dropped functions", () => {
    const store = createStore({
      settings: proxyMap<string, { action: () => number; value: number }>([
        ["a", { action: () => 1, value: 2 }],
      ]),
    });
    const stateSnapshot = snapshot(store);

    const encoded = encodeDevtoolsGraph(stateSnapshot);
    if (encoded.kind !== "encoded") throw new Error("expected the snapshot to encode");
    expect(encoded.requiresLocalSnapshot).toBe(true);
  });

  it("detects state code through aliases first seen outside the reactive entry", () => {
    const withGetter = {
      get computed() {
        return 1;
      },
    };
    const store = createStore({
      plain: withGetter,
      settings: proxyMap<string, unknown>([["k", withGetter]]),
    });
    const stateSnapshot = snapshot(store);

    const encoded = encodeDevtoolsGraph(stateSnapshot);
    if (encoded.kind !== "encoded") throw new Error("expected the snapshot to encode");
    expect(encoded.requiresLocalSnapshot).toBe(true);
  });

  it("detects state code nested inside native collections within reactive entries", () => {
    const withGetter = {
      get computed() {
        return 1;
      },
    };
    const store = createStore({
      settings: proxyMap<string, unknown>([["k", new Map([["inner", withGetter]])]]),
    });
    const stateSnapshot = snapshot(store);

    const encoded = encodeDevtoolsGraph(stateSnapshot);
    if (encoded.kind !== "encoded") throw new Error("expected the snapshot to encode");
    expect(encoded.requiresLocalSnapshot).toBe(true);
  });

  it("keeps requiresLocalSnapshot false for state code outside reactive collections", () => {
    const store = createStore({
      plain: {
        get computed() {
          return 1;
        },
      },
      settings: proxyMap<string, number>([["k", 1]]),
    });
    const stateSnapshot = snapshot(store);

    const encoded = encodeDevtoolsGraph(stateSnapshot);
    if (encoded.kind !== "encoded") throw new Error("expected the snapshot to encode");
    expect(encoded.requiresLocalSnapshot).toBe(false);
  });

  it("reports encode failures with the graph walk's own error", () => {
    const weak = { leak: new WeakMap() };
    const failed = encodeDevtoolsGraph(weak);
    if (failed.kind !== "encode-failed") throw new Error("expected the WeakMap to fail encoding");
    expect(failed.requiresLocalSnapshot).toBe(true);
    expect(failed.graph).toBeUndefined();
    if (!(failed.encodeError instanceof TypeError)) throw new Error("expected a TypeError");
    expect(failed.encodeError.message).toEqual("statelift: cannot serialize WeakMap at $.leak");

    const frozen = { holder: Object.freeze({ fn: () => 1 }) };
    const frozenFailed = encodeDevtoolsGraph(frozen);
    if (frozenFailed.kind !== "encode-failed") {
      throw new Error("expected the frozen function to fail encoding");
    }
    if (!(frozenFailed.encodeError instanceof TypeError)) throw new Error("expected a TypeError");
    expect(frozenFailed.encodeError.message).toEqual("statelift: cannot serialize a function at $.holder.fn");
  });

  it("reports a local-symbol key ahead of the same property's invalid value", () => {
    const localKey = Symbol("local");
    const holder: Record<symbol, unknown> = {};
    holder[localKey] = () => 1;

    const failed = encodeDevtoolsGraph({ holder });
    if (failed.kind !== "encode-failed") throw new Error("expected the local symbol to fail encoding");
    if (!(failed.encodeError instanceof TypeError)) throw new Error("expected a TypeError");
    expect(failed.encodeError.message).toEqual(
      "statelift: cannot serialize a local symbol at $.holder.Symbol(local)",
    );
  });
});

type AssertFalse<T extends false> = T;
type TrustedHydration = DeepPartial<{ n: number }> | Dehydrated<{ n: number }>;
type _TrustedHydrationRejectsWrongScalar = AssertFalse<{ n: string } extends TrustedHydration ? true : false>;
type _TrustedHydrationRejectsUnknown = AssertFalse<unknown extends TrustedHydration ? true : false>;
