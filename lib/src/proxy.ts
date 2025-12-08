/* eslint-disable no-param-reassign */
const UNWRAP_PROXY_KEY = Symbol("unwrapped-target");

const BUILT_IN_OBJECTS = [Map, Set, WeakMap, WeakSet, Date, RegExp, ArrayBuffer, Promise] as const;

export const WELL_KNOWN_SYMBOLS = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map((key) => Symbol[key as keyof SymbolConstructor])
    .filter((value): value is symbol => typeof value === "symbol"),
);

const COMPOUND_ARRAY_METHODS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

export const hasInternalSlots = (value: unknown): boolean => {
  if (ArrayBuffer.isView(value)) return true;
  return BUILT_IN_OBJECTS.some((ctor) => value instanceof ctor);
};

export type ProxyCallbacks = {
  get: (target: {}, prop: string | symbol, receiver: {}, value: unknown) => void;
  set: (
    target: {},
    prop: string | symbol,
    value: unknown,
    receiver: {},
    isNewProperty: boolean,
    oldArrayLength?: number,
  ) => void;
  deleteProperty: (target: {}, prop: string | symbol) => void;
  ownKeys: (target: {}) => void;
  // called after a compound array operation completes (splice, reverse, sort, etc.)
  arrayMethodComplete?: (target: unknown[], method: string) => void;
};

export const unwrapProxy = <T extends {}>(object: T, deep = false): T => {
  if (typeof object !== "object" || object === null || object instanceof Function) return object;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let unwrapped = (object as unknown as { [UNWRAP_PROXY_KEY]: T })[UNWRAP_PROXY_KEY] as any;
  if (deep) {
    while (unwrapped && unwrapped[UNWRAP_PROXY_KEY]) {
      unwrapped = unwrapped[UNWRAP_PROXY_KEY];
    }
  }
  return unwrapped ?? object;
};

export const createDeepProxy = <T extends object>(
  object: T,
  options?: {
    callbacks?: Partial<ProxyCallbacks>;
    unwrapSet?: boolean;
    strict?: boolean;
  },
) => {
  const proxyCache = new WeakMap<{}, {}>();
  let inSetTrap = false;
  // batch compound array operations -> single notification
  let compoundMethodLock = false;

  const handler: ProxyHandler<{}> = {
    get(target, prop, receiver) {
      if (prop === UNWRAP_PROXY_KEY) return target;

      // skip tracking for well-known symbols
      if (typeof prop === "symbol" && WELL_KNOWN_SYMBOLS.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      const value = Reflect.get(target, prop, receiver);
      let result = value;

      // wrap compound array methods
      if (
        Array.isArray(target) &&
        typeof prop === "string" &&
        COMPOUND_ARRAY_METHODS.has(prop) &&
        typeof value === "function"
      ) {
        const methodName = prop;
        result = function (this: unknown[], ...args: unknown[]) {
          compoundMethodLock = true;
          try {
            const returnValue = value.apply(this, args);
            return returnValue;
          } finally {
            compoundMethodLock = false;
            options?.callbacks?.arrayMethodComplete?.(target as unknown[], methodName);
          }
        };
        options?.callbacks?.get?.(target, prop, receiver, result);
        return result;
      }

      if (typeof value === "object" && value !== null && !(value instanceof Function)) {
        if (hasInternalSlots(value)) {
          if (options?.strict) {
            throw new Error(
              `Statelift: Built-in object "${value.constructor.name}" detected in state. ` +
                `Built-in objects (Map, Set, Date, RegExp, etc.) are not reactive. ` +
                `Use plain objects/arrays, or disable strict mode if this is intentional.`,
            );
          }
        } else if (proxyCache.has(value)) {
          result = proxyCache.get(value);
        } else {
          const proxy = new Proxy(value, handler);
          proxyCache.set(value, proxy);
          result = proxy;
        }
      }
      options?.callbacks?.get?.(target, prop, receiver, result);
      return result;
    },
    set(target, prop, value, receiver) {
      const isNewProperty = !Object.hasOwn(target, prop);
      const oldArrayLength =
        Array.isArray(target) && prop === "length" && typeof value === "number" ?
          (target as unknown[]).length
        : undefined;
      const isArrayLengthTruncation = oldArrayLength !== undefined && value < oldArrayLength;
      const unwrappedValue = options?.unwrapSet ? unwrapProxy(value, true) : value;
      inSetTrap = true;
      const result = Reflect.set(target, prop, unwrappedValue, receiver);
      inSetTrap = false;

      // prevents duplicate notifications from inheritance
      const unwrappedReceiver = unwrapProxy(receiver as {}, true);
      if (target !== unwrappedReceiver) {
        return result;
      }

      // skip notifications for compound ops
      if (!compoundMethodLock) {
        options?.callbacks?.set?.(target, prop, unwrappedValue, receiver, isNewProperty, oldArrayLength);
        if (isArrayLengthTruncation) {
          options?.callbacks?.ownKeys?.(target);
        }
      }
      return result;
    },
    deleteProperty(target, prop) {
      const result = Reflect.deleteProperty(target, prop);
      options?.callbacks?.deleteProperty?.(target, prop);
      return result;
    },
    ownKeys(target) {
      options?.callbacks?.ownKeys?.(target);
      return Reflect.ownKeys(target);
    },
    has(target, prop) {
      const exists = Reflect.has(target, prop);
      options?.callbacks?.get?.(target, prop, target, exists);
      return exists;
    },
    defineProperty(target, prop, descriptor) {
      const isNewProperty = !Object.hasOwn(target, prop);
      const result = Reflect.defineProperty(target, prop, descriptor);
      if (result && !inSetTrap) {
        options?.callbacks?.set?.(target, prop, descriptor.value, target, isNewProperty, undefined);
      }
      return result;
    },
  };

  return new Proxy(object, handler) as T;
};

export const createRootProxy = <T extends {}>(
  builder: (root: T) => T,
  options?: {
    callbacks: ProxyCallbacks;
    strict?: boolean;
  },
) => {
  const skeleton = {} as T;
  const root = createDeepProxy(skeleton, {
    callbacks: options?.callbacks,
    unwrapSet: true,
    strict: options?.strict,
  });

  const builderResult = builder(root);
  const descriptors = Object.getOwnPropertyDescriptors(builderResult);
  Object.defineProperties(skeleton, descriptors);

  return root;
};
