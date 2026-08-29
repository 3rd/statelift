import type { Store } from "./store";
import type { TransportEnvelope } from "./transport";
import { getActionLabel, restore, snapshot, subscribe } from "./store";
import { createTransportPreview, decodeTransportEnvelope, encodeDevtoolsGraph } from "./transport";
import { IS_DEV } from "./utils";

export type DevtoolsOptions = {
  /** Instance label in the DevTools panel. Default: `"statelift-<n>"`. */
  name?: string;
  /** Default: enabled outside production builds. */
  enabled?: boolean;
  /** Maximum history entries retained by the extension and local snapshot cache. Default: 50. */
  maxAge?: number;
};

type DevtoolsMessage = {
  type: string;
  payload?: { type?: string; status?: boolean };
  state?: string;
};

type DevtoolsConnection = {
  init: (state: unknown) => void;
  send: (action: { type: string }, state: unknown) => void;
  subscribe: (listener: (message: DevtoolsMessage) => void) => (() => void) | undefined;
  unsubscribe?: () => void;
};

type DevtoolsExtension = {
  connect: (options: { name: string; maxAge: number }) => DevtoolsConnection;
};

type DevtoolsConnector = <T extends {}>(store: Store<T>, options?: DevtoolsOptions) => () => void;

type DevtoolsState = {
  state: unknown;
  $statelift: {
    version: 1;
    snapshotId: number;
    requiresLocalSnapshot: boolean;
    graph?: TransportEnvelope;
  };
};

const noop = () => {};
const DEFAULT_MAX_AGE = 50;

let instanceCounter = 0;

/** Connects a store to Redux DevTools and returns an idempotent disconnect function. */
export const devtools: DevtoolsConnector = <T extends {}>(store: Store<T>, options?: DevtoolsOptions) => {
  const enabled = options?.enabled ?? IS_DEV;
  if (!enabled) return noop;

  const extension = (globalThis as { __REDUX_DEVTOOLS_EXTENSION__?: DevtoolsExtension })
    .__REDUX_DEVTOOLS_EXTENSION__;
  if (!extension) return noop;

  const name = options?.name ?? `statelift-${++instanceCounter}`;
  const maxAge = options?.maxAge ?? DEFAULT_MAX_AGE;
  if (!Number.isSafeInteger(maxAge) || maxAge <= 1) {
    throw new RangeError("statelift: devtools maxAge must be an integer greater than 1");
  }
  const connection = extension.connect({ name, maxAge });

  let nextSnapshotId = 0;
  let encodeFailureWarned = false;
  const localSnapshots = new Map<number, ReturnType<typeof snapshot<T>>>();
  const createDevtoolsState = (stateSnapshot: ReturnType<typeof snapshot<T>>): DevtoolsState => {
    const snapshotId = ++nextSnapshotId;
    localSnapshots.set(snapshotId, stateSnapshot);
    while (localSnapshots.size > maxAge) {
      const oldestSnapshotId = localSnapshots.keys().next().value;
      if (typeof oldestSnapshotId !== "number") break;
      localSnapshots.delete(oldestSnapshotId);
    }
    const encoded = encodeDevtoolsGraph(stateSnapshot);
    if (encoded.kind === "encode-failed") {
      if (!encodeFailureWarned) {
        encodeFailureWarned = true;
        console.warn(
          `statelift: devtools cannot transport-encode the state of "${name}"; time travel is limited to the ${maxAge} most recent in-process snapshots`,
          encoded.encodeError,
        );
      }
      return {
        state: createTransportPreview(stateSnapshot),
        $statelift: { version: 1, snapshotId, requiresLocalSnapshot: true },
      };
    }
    return {
      state: createTransportPreview(stateSnapshot),
      $statelift: {
        version: 1,
        snapshotId,
        requiresLocalSnapshot: encoded.requiresLocalSnapshot,
        graph: encoded.graph,
      },
    };
  };
  const initializeHistory = (stateSnapshot: ReturnType<typeof snapshot<T>>) => {
    localSnapshots.clear();
    connection.init(createDevtoolsState(stateSnapshot));
  };

  let committedSnapshot = snapshot(store);
  connection.init(createDevtoolsState(committedSnapshot));

  // Keep the flag active through restore's synchronous notification flush.
  let applying = false;
  let recordingPaused = false;

  const unsubscribeStore = subscribe(store, () => {
    if (applying || recordingPaused) return;
    connection.send({ type: getActionLabel(store) ?? "mutation" }, createDevtoolsState(snapshot(store)));
  });

  const applyState = (data: unknown) => {
    if (data === null || typeof data !== "object") return;
    applying = true;
    try {
      Reflect.apply(restore, undefined, [store, data]);
    } finally {
      applying = false;
    }
  };

  const parseMessageState = (message: DevtoolsMessage): unknown => {
    if (typeof message.state !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(message.state);
      if (parsed !== null && typeof parsed === "object") {
        const metadata = Reflect.get(parsed, "$statelift");
        if (metadata !== null && typeof metadata === "object" && Reflect.get(metadata, "version") === 1) {
          const snapshotId = Reflect.get(metadata, "snapshotId");
          if (typeof snapshotId !== "number" || !Number.isSafeInteger(snapshotId) || snapshotId < 1) {
            throw new TypeError("statelift: devtools snapshot id is invalid");
          }
          const localSnapshot = localSnapshots.get(snapshotId);
          if (localSnapshot !== undefined) return localSnapshot;
          if (Reflect.get(metadata, "requiresLocalSnapshot") === true) {
            throw new TypeError("statelift: devtools state requires its original in-process snapshot");
          }
          return decodeTransportEnvelope(Reflect.get(metadata, "graph"));
        }
      }
      return decodeTransportEnvelope(parsed);
    } catch {
      console.warn(`statelift: devtools sent an unparseable state payload for "${name}"`);
      return null;
    }
  };

  const unsubscribeConnection = connection.subscribe((message) => {
    if (message.type !== "DISPATCH") return;

    switch (message.payload?.type) {
      case "JUMP_TO_ACTION":
      case "JUMP_TO_STATE": {
        const data = parseMessageState(message);
        if (data) applyState(data);
        break;
      }
      case "ROLLBACK": {
        const data = parseMessageState(message);
        if (data) {
          applyState(data);
          committedSnapshot = snapshot(store);
          initializeHistory(committedSnapshot);
        }
        break;
      }
      case "RESET": {
        applyState(committedSnapshot);
        initializeHistory(committedSnapshot);
        break;
      }
      case "COMMIT": {
        committedSnapshot = snapshot(store);
        initializeHistory(committedSnapshot);
        break;
      }
      case "PAUSE_RECORDING": {
        const status = message.payload?.status;
        if (typeof status === "boolean") recordingPaused = status;
        break;
      }
      default: {
        break;
      }
    }
  });

  let disconnected = false;
  return () => {
    if (disconnected) return;
    disconnected = true;
    localSnapshots.clear();
    unsubscribeStore();
    if (typeof unsubscribeConnection === "function") {
      unsubscribeConnection();
    }
    connection.unsubscribe?.();
  };
};
