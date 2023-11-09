/* eslint-disable no-param-reassign */
export type ProxyCallbacks = {
  get: (target: {}, prop: string | symbol, receiver: {}) => void;
  set: (target: {}, prop: string | symbol, value: unknown, receiver: {}) => void;
  deleteProperty: (target: {}, prop: string | symbol) => void;
};

export const createDeepProxy = <T extends object>(
  object: T,
  options?: {
    callbacks: {
      get?: (target: {}, prop: string | symbol, receiver: {}) => void;
      set?: (target: {}, prop: string | symbol, value: unknown, receiver: {}) => void;
      deleteProperty?: (target: {}, prop: string | symbol) => void;
    };
  }
) => {
  const proxyCache = new Map<{}, {}>();

  const handler: ProxyHandler<{}> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      options?.callbacks?.get?.(target, prop, receiver);
      if (typeof value === "object" && value !== null && !(value instanceof Function)) {
        if (proxyCache.has(value)) return proxyCache.get(value);
        const proxy = new Proxy(value, handler);
        proxyCache.set(value, proxy);
        return proxy;
      }
      return value;
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
      get?: (target: {}, prop: string | symbol, receiver: {}) => void;
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
