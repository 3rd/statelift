/* eslint-disable no-param-reassign */
const UNWRAP_PROXY_KEY = Symbol("unwrapped-target");

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
  },
) => {
  const proxyCache = new WeakMap<{}, {}>();

  const handler: ProxyHandler<{}> = {
    get(target, prop, receiver) {
      if (prop === UNWRAP_PROXY_KEY) return target;

      const value = Reflect.get(target, prop, receiver);
      let result = value;
      if (typeof value === "object" && value !== null && !(value instanceof Function)) {
        if (proxyCache.has(value)) {
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
      const result = Reflect.set(target, prop, unwrappedValue, receiver);
      options?.callbacks?.set?.(target, prop, unwrappedValue, receiver, isNewProperty, oldArrayLength);
      if (isArrayLengthTruncation) {
        options?.callbacks?.ownKeys?.(target);
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
  };

  return new Proxy(object, handler) as T;
};

export const createRootProxy = <T extends {}>(
  builder: (root: T) => T,
  options?: {
    callbacks: ProxyCallbacks;
  },
) => {
  const skeleton = {} as T;
  const root = createDeepProxy(skeleton, {
    callbacks: options?.callbacks,
    unwrapSet: true,
  });

  const builderResult = builder(root);
  const descriptors = Object.getOwnPropertyDescriptors(builderResult);
  Object.defineProperties(skeleton, descriptors);

  return root;
};
