import { describe, expect, it, mock, spyOn } from "bun:test";
import { proxyMap, proxySet } from "./collections";
import { devtools } from "./devtools";
import { batch, createConsumer, createStore } from "./store";
import { decodeTransportEnvelope, encodeTransportEnvelope } from "./transport";

type DevtoolsListener = (message: {
  type: string;
  payload?: { type?: string; status?: boolean };
  state?: string;
}) => void;

type FakeConnection = {
  name: string;
  maxAge: number;
  init: ReturnType<typeof mock>;
  send: ReturnType<typeof mock>;
  listener: DevtoolsListener | null;
  unsubscribe: ReturnType<typeof mock>;
};

const decodeDevtoolsState = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") throw new Error("DevTools state is missing");
  const metadata = Reflect.get(value, "$statelift");
  if (metadata === null || typeof metadata !== "object") throw new Error("DevTools metadata is missing");
  return decodeTransportEnvelope(Reflect.get(metadata, "graph"));
};

const getMockCall = (mockFunction: ReturnType<typeof mock>, index: number) => {
  const call = mockFunction.mock.calls.at(index);
  if (call === undefined) throw new Error("expected mock call is missing");
  return call;
};

const getActionType = (call: unknown[]) => {
  const action = call[0];
  if (action === null || typeof action !== "object") throw new Error("DevTools action is missing");
  const type = Reflect.get(action, "type");
  if (typeof type !== "string") throw new Error("DevTools action type is missing");
  return type;
};

const installFakeExtension = () => {
  const connections: FakeConnection[] = [];
  const connection = () => {
    const current = connections[0];
    if (current === undefined) throw new Error("DevTools connection was not created");
    return current;
  };
  Reflect.set(globalThis, "__REDUX_DEVTOOLS_EXTENSION__", {
    connect: ({ name, maxAge }: { name: string; maxAge: number }) => {
      const current: FakeConnection = {
        name,
        maxAge,
        init: mock(),
        send: mock(),
        listener: null,
        unsubscribe: mock(),
      };
      connections.push(current);
      return {
        init: current.init,
        send: current.send,
        subscribe: (listener: DevtoolsListener) => {
          current.listener = listener;
          return () => {};
        },
        unsubscribe: current.unsubscribe,
      };
    },
  });

  return {
    connection,
    connections,
    dispatch: (payloadType: string, state?: unknown) => {
      connection().listener?.({
        type: "DISPATCH",
        payload: { type: payloadType },
        state: state === undefined ? undefined : JSON.stringify(encodeTransportEnvelope(state)),
      });
    },
    dispatchPayload: (payloadType: string, state: unknown) => {
      connection().listener?.({
        type: "DISPATCH",
        payload: { type: payloadType },
        state: JSON.stringify(state),
      });
    },
    remove: () => {
      Reflect.deleteProperty(globalThis, "__REDUX_DEVTOOLS_EXTENSION__");
    },
  };
};

describe("devtools", () => {
  it("is a silent no-op without the extension", () => {
    const store = createStore({ n: 1 });

    const disconnect = devtools(store);
    expect(typeof disconnect).toBe("function");

    store.state.n = 2;
    disconnect();
  });

  it("does not touch the extension when disabled", () => {
    const fake = installFakeExtension();
    try {
      devtools(createStore({ n: 1 }), { enabled: false });
      expect(fake.connections.length).toEqual(0);
    } finally {
      fake.remove();
    }
  });

  it("connects with the custom name and the initial snapshot", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ n: 1 });
      const disconnect = devtools(store, { name: "custom" });
      const connection = fake.connection();

      expect(connection.name).toEqual("custom");
      expect(connection.maxAge).toBe(50);
      expect(connection.init).toHaveBeenCalledTimes(1);
      const initialCall = getMockCall(connection.init, 0);
      const initialized = decodeDevtoolsState(initialCall[0]);
      expect(initialized).toEqual({ n: 1 });
      const payload = initialCall[0];
      if (payload === null || typeof payload !== "object") throw new Error("DevTools payload is missing");
      expect(Reflect.get(payload, "state")).toEqual({ n: 1 });

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("validates and forwards the history limit", () => {
    const fake = installFakeExtension();
    try {
      const disconnect = devtools(createStore({ n: 1 }), { maxAge: 2 });
      expect(fake.connection().maxAge).toBe(2);
      disconnect();

      expect(() => devtools(createStore({ n: 1 }), { maxAge: 1 })).toThrow(/greater than 1/);
    } finally {
      fake.remove();
    }
  });

  it("sends one mutation entry per change and per batch", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ a: 1, b: 2 });
      const disconnect = devtools(store);
      const { send } = fake.connection();

      store.state.a = 10;
      expect(send).toHaveBeenCalledTimes(1);

      batch(store, () => {
        store.state.a = 20;
        store.state.b = 21;
      });
      expect(send).toHaveBeenCalledTimes(2);
      const lastSend = getMockCall(send, -1);
      expect(lastSend[0]).toEqual({ type: "mutation" });
      expect(decodeDevtoolsState(lastSend[1])).toEqual({ a: 20, b: 21 });

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("time-travel recursively restores state through mutation paths", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({
        nested: {
          v: 1,
          get double() {
            return this.v * 2;
          },
          bump() {
            this.v++;
          },
        },
      });
      const disconnect = devtools(store);
      const onRerender = mock();
      const consumer = createConsumer(store, onRerender);
      void consumer.proxy.nested.v;

      fake.dispatch("JUMP_TO_STATE", { nested: { v: 5, double: 999 } });

      expect(store.state.nested.v).toEqual(5);
      expect(store.state.nested.double).toEqual(10);
      expect(typeof store.state.nested.bump).toEqual("function");
      expect(onRerender.mock.calls.length).toBeGreaterThanOrEqual(1);
      store.state.nested.bump();
      expect(store.state.nested.v).toEqual(6);

      consumer.destroy();
      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("uses mutation fallback and preserves explicit batch labels", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ count: 0 });
      const disconnect = devtools(store);
      const { send } = fake.connection();

      store.state.count = 1;
      expect(getActionType(getMockCall(send, -1))).toEqual("mutation");

      batch(
        store,
        () => {
          store.state.count = 100;
        },
        { label: "reset-count" },
      );
      expect(getActionType(getMockCall(send, -1))).toEqual("reset-count");

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("sends containers through graph envelopes and RESET restores their entries", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ users: proxyMap<string, number>([["a", 1]]) });
      const disconnect = devtools(store);
      const { init, send } = fake.connection();

      const initial = decodeDevtoolsState(getMockCall(init, 0)[0]);
      if (initial === null || typeof initial !== "object") throw new Error("initial state is missing");
      const initialUsers = Reflect.get(initial, "users");
      expect(initialUsers).toBeInstanceOf(Map);
      expect(initialUsers instanceof Map ? [...initialUsers] : []).toEqual([["a", 1]]);

      store.state.users.set("b", 2);
      const sent = decodeDevtoolsState(getMockCall(send, -1)[1]);
      if (sent === null || typeof sent !== "object") throw new Error("sent state is missing");
      const sentUsers = Reflect.get(sent, "users");
      expect(sentUsers instanceof Map ? [...sentUsers] : []).toEqual([
        ["a", 1],
        ["b", 2],
      ]);

      store.state.users.set("a", 99);
      fake.dispatch("RESET");

      expect(store.state.users.get("a")).toEqual(1);
      expect(store.state.users.has("b")).toBe(false);
      expect(store.state.users.size).toEqual(1);

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("suppresses the send echo during time-travel", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ n: 1 });
      const disconnect = devtools(store);
      const { send } = fake.connection();

      store.state.n = 2;
      expect(send).toHaveBeenCalledTimes(1);

      fake.dispatch("JUMP_TO_STATE", { n: 3 });
      expect(store.state.n).toEqual(3);
      expect(send).toHaveBeenCalledTimes(1);

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("uses the original snapshot for object-valued proxySet time travel", () => {
    type Item = {
      value: number;
      increment: () => void;
      readonly double: number;
    };
    const fake = installFakeExtension();
    try {
      const item: Item = {
        value: 1,
        increment() {
          this.value++;
        },
        get double() {
          return this.value * 2;
        },
      };
      const store = createStore({ items: proxySet<Item>([item]), alias: item });
      const disconnect = devtools(store);
      const initialPayload = getMockCall(fake.connection().init, 0)[0];
      const original = store.state.alias;

      original.value = 9;
      store.state.items.delete(original);
      store.state.alias = {
        value: 5,
        increment() {
          this.value++;
        },
        get double() {
          return this.value * 2;
        },
      };
      fake.dispatchPayload("JUMP_TO_STATE", initialPayload);

      const restored = [...store.state.items][0];
      if (restored === undefined) throw new Error("restored Set member is missing");
      expect(restored).toBe(original);
      expect(store.state.alias).toBe(original);
      expect(restored.value).toBe(1);
      expect(restored.double).toBe(2);
      restored.increment();
      expect(restored.value).toBe(2);

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("evicts local snapshots with the same maxAge used by the extension", () => {
    const fake = installFakeExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const item = {
        value: 1,
        increment() {
          this.value++;
        },
      };
      const store = createStore({ items: proxySet([item]), alias: item });
      const disconnect = devtools(store, { maxAge: 2 });
      const initialPayload = getMockCall(fake.connection().init, 0)[0];

      store.state.alias.value = 2;
      store.state.alias.value = 3;
      fake.dispatchPayload("JUMP_TO_STATE", initialPayload);

      expect(store.state.alias.value).toBe(3);
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes("unparseable"))).toBe(true);
      disconnect();
    } finally {
      warnSpy.mockRestore();
      fake.remove();
    }
  });

  it("retains recorded local snapshots while recording is paused", () => {
    const fake = installFakeExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const item = {
        value: 1,
        increment() {
          this.value++;
        },
      };
      const store = createStore({ items: proxySet([item]), alias: item });
      const disconnect = devtools(store, { maxAge: 2 });
      const connection = fake.connection();
      const initialPayload = getMockCall(connection.init, 0)[0];

      connection.listener?.({
        type: "DISPATCH",
        payload: { type: "PAUSE_RECORDING", status: true },
      });
      store.state.alias.value = 2;
      store.state.alias.value = 3;
      connection.listener?.({
        type: "DISPATCH",
        payload: { type: "PAUSE_RECORDING", status: false },
      });
      store.state.alias.value = 4;
      fake.dispatchPayload("JUMP_TO_STATE", initialPayload);

      expect(store.state.alias.value).toBe(1);
      expect(connection.send).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
      disconnect();
    } finally {
      warnSpy.mockRestore();
      fake.remove();
    }
  });

  it("replace semantics remove live keys missing from the payload", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore<{ a: number; b?: number }>({ a: 1, b: 2 });
      const disconnect = devtools(store);

      fake.dispatch("JUMP_TO_STATE", { a: 5 });

      expect(store.state.a).toEqual(5);
      expect("b" in store.state).toBe(false);

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("RESET restores the initial state and keeps it mutable", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ nested: { v: 1 }, top: 1 });
      const disconnect = devtools(store);

      store.state.nested.v = 5;
      store.state.top = 9;
      fake.dispatch("RESET");

      expect(store.state.nested.v).toEqual(1);
      expect(store.state.top).toEqual(1);
      expect(fake.connection().init).toHaveBeenCalledTimes(2);

      store.state.nested.v = 7;
      expect(store.state.nested.v).toEqual(7);

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("COMMIT reinitializes history and becomes the RESET baseline", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ n: 0 });
      const disconnect = devtools(store);

      store.state.n = 5;
      fake.dispatch("COMMIT");
      expect(fake.connection().init).toHaveBeenCalledTimes(2);
      expect(decodeDevtoolsState(getMockCall(fake.connection().init, -1)[0])).toEqual({ n: 5 });
      store.state.n = 9;
      fake.dispatch("RESET");

      expect(store.state.n).toBe(5);
      expect(decodeDevtoolsState(getMockCall(fake.connection().init, -1)[0])).toEqual({ n: 5 });
      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("ROLLBACK applies the payload and re-inits with it", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ n: 1 });
      const disconnect = devtools(store);

      store.state.n = 5;
      fake.dispatch("ROLLBACK", { n: 3 });

      expect(store.state.n).toEqual(3);
      expect(decodeDevtoolsState(getMockCall(fake.connection().init, -1)[0])).toEqual({ n: 3 });
      store.state.n = 7;
      fake.dispatch("RESET");
      expect(store.state.n).toBe(3);

      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("rejects malformed tagged maps before changing live collection data", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ users: proxyMap<string, number>([["kept", 1]]) });
      const disconnect = devtools(store);

      expect(() => fake.dispatch("JUMP_TO_STATE", { users: { __map: [["bad"]] } })).toThrow(
        "statelift: cannot restore proxyMap from the supplied value",
      );
      expect([...store.state.users]).toEqual([["kept", 1]]);
      disconnect();
    } finally {
      fake.remove();
    }
  });

  it("warns and ignores unparseable time-travel payloads", () => {
    const fake = installFakeExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createStore({ n: 1 });
      const disconnect = devtools(store);

      fake.connection().listener?.({
        type: "DISPATCH",
        payload: { type: "JUMP_TO_ACTION" },
        state: "{oops",
      });

      expect(store.state.n).toEqual(1);
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes("unparseable"))).toBe(true);

      disconnect();
    } finally {
      warnSpy.mockRestore();
      fake.remove();
    }
  });

  it("degrades instead of throwing when state cannot be transport-encoded", () => {
    const fake = installFakeExtension();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createStore({ n: 1, pending: Promise.resolve("x") });
      const disconnect = devtools(store);
      const connection = fake.connection();
      expect(connection.init).toHaveBeenCalledTimes(1);
      const initialPayload = getMockCall(connection.init, 0)[0];

      store.state.n = 2;
      store.state.n = 3;
      expect(connection.send).toHaveBeenCalledTimes(2);

      const lastSend = connection.send.mock.calls.at(-1);
      if (lastSend === undefined) throw new Error("DevTools send was never called");
      const sent: unknown = lastSend[1];
      if (sent === null || typeof sent !== "object") throw new Error("DevTools payload is missing");
      const metadata = Reflect.get(sent, "$statelift");
      if (metadata === null || typeof metadata !== "object") throw new Error("DevTools metadata is missing");
      expect(Reflect.get(metadata, "requiresLocalSnapshot")).toBe(true);
      expect(Reflect.has(metadata, "graph")).toBe(false);

      const encodeWarns = warnSpy.mock.calls.filter(([message]) =>
        String(message).includes("cannot transport-encode"),
      );
      expect(encodeWarns.length).toEqual(1);
      fake.dispatchPayload("JUMP_TO_STATE", initialPayload);
      expect(store.state.n).toEqual(1);
      disconnect();
    } finally {
      warnSpy.mockRestore();
      fake.remove();
    }
  });

  it("disconnect stops forwarding and unsubscribes the extension exactly once", () => {
    const fake = installFakeExtension();
    try {
      const store = createStore({ n: 1 });
      const disconnect = devtools(store);
      const connection = fake.connection();

      disconnect();
      store.state.n = 2;

      expect(connection.send).toHaveBeenCalledTimes(0);
      expect(connection.unsubscribe).toHaveBeenCalledTimes(1);

      disconnect();
      expect(connection.unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      fake.remove();
    }
  });
});
