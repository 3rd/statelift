/* eslint-disable no-param-reassign */
const UNWRAP_PROXY_KEY = Symbol("unwrapped-target");

export type ProxyCallbacks = {
  get: (target: {}, prop: string | symbol, receiver: {}) => void;
  set: (target: {}, prop: string | symbol, value: unknown, receiver: {}) => void;
  deleteProperty: (target: {}, prop: string | symbol) => void;
};

export const createDeepProxy = <T extends object>(
  object: T,
  options?: {
    callbacks: {
      get?: (target: {}, prop: string | symbol, receiver: {}, value: unknown) => void;
      set?: (target: {}, prop: string | symbol, value: unknown, receiver: {}) => void;
      deleteProperty?: (target: {}, prop: string | symbol) => void;
    };
  }
) => {
  const proxyCache = new Map<{}, {}>();

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
      const result = Reflect.set(target, prop, value, receiver);
      options?.callbacks?.set?.(target, prop, value, receiver);
      return result;
    },
    deleteProperty(target, prop) {
      const result = Reflect.deleteProperty(target, prop);
      options?.callbacks?.deleteProperty?.(target, prop);
      return result;
    },
  };

  return new Proxy(object, handler) as T;
};

export const createRootProxy = <T extends object>(
  builder: (root: T) => T,
  options?: {
    callbacks: {
      get?: (target: {}, prop: string | symbol, receiver: {}, value: unknown) => void;
      set?: (target: {}, prop: string | symbol, value: unknown, receiver: {}) => void;
      deleteProperty?: (target: {}, prop: string | symbol) => void;
    };
  }
) => {
  const skeleton = {} as T;
  const root = createDeepProxy(skeleton, options);

  const builderResult = builder(root);
  const descriptors = Object.getOwnPropertyDescriptors(builderResult);
  Object.defineProperties(skeleton, descriptors);

  return root;
};

export const unwrapProxy = <T extends {}>(object: T): T => {
  return (object as unknown as { [UNWRAP_PROXY_KEY]: T })[UNWRAP_PROXY_KEY];
};
