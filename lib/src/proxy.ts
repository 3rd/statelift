/* eslint-disable no-param-reassign */
const PROXY_ID_SYMBOL = Symbol("type");
const PROXY_UNWRAP_SYMBOL = Symbol("proxy-unwrap");

export type ProxyCallbacks = {
  get: (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: unknown) => void;
  set: (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: unknown) => void;
  delete: (proxy: ProxyCacheValue, target: {}, key: string | symbol) => void;
};

export type ProxyCacheValue<T extends {} = {}> = {
  target: T;
  instance: T;
  callbacks?: Partial<ProxyCallbacks>;
  rootProxy?: ProxyCacheValue;
  [PROXY_ID_SYMBOL]: symbol;
};
const rootCache = new Map<symbol, WeakMap<{}, ProxyCacheValue>>();

type CreateDeepProxyOptions = {
  callbacks?: Partial<ProxyCallbacks>;
  isRoot?: boolean;
  rootProxy?: ProxyCacheValue;
  rootSymbol?: symbol;
};

let count = 0;
export const createDeepProxy = <T extends {}>(target: T, options: CreateDeepProxyOptions = {}) => {
  const rootSymbol = options.rootSymbol ?? Symbol(`state-proxy:${count++}`);
  const callbacks = options.callbacks;
  const isRoot = options.isRoot !== false;

  // console.warn("createDeepProxy", { rootSymbol, isRoot, options, target });

  let proxyCache = rootCache.get(rootSymbol);
  if (!proxyCache) {
    proxyCache = new WeakMap();
    rootCache.set(rootSymbol, proxyCache);
  }

  const cachedProxy = proxyCache.get(target);

  if (cachedProxy) {
    if (isRoot && callbacks) cachedProxy.callbacks = callbacks;
    return cachedProxy as ProxyCacheValue<T>;
  }

  const proxy: ProxyCacheValue<T> = {
    target,
    instance: null as unknown as T,
    rootProxy: options.rootProxy,
    callbacks,
    [PROXY_ID_SYMBOL]: rootSymbol,
  };

  const rootProxy = isRoot ? proxy : options.rootProxy!;

  const nextOptions = {
    rootSymbol,
    rootProxy,
    isRoot: false,
  };

  const handler: ProxyHandler<T> = {
    get(obj, prop, receiver) {
      if (prop === PROXY_UNWRAP_SYMBOL) return obj;

      const value = Reflect.get(obj, prop, receiver);
      // console.log("@proxy get", rootSymbol, prop, { proxy, obj, prop, value });

      if (value && typeof value === "object") {
        const proxiedValue = createDeepProxy(value, nextOptions).instance;
        rootProxy.callbacks?.get?.(proxy, obj, prop, proxiedValue);
        return proxiedValue;
      }
      rootProxy.callbacks?.get?.(proxy, obj, prop, value);
      return value;
    },
    set(obj, prop, value, receiver) {
      // console.log("@proxy set", { proxy, target: obj, prop, value });
      const result = Reflect.set(obj, prop, value, receiver);
      rootProxy.callbacks?.set?.(proxy, obj, prop, value);
      return result;
    },
    deleteProperty(obj, prop) {
      // console.log("@proxy deleteProperty", { proxy, target: obj, prop });
      const result = Reflect.deleteProperty(obj, prop);
      rootProxy.callbacks?.delete?.(proxy, obj, prop);
      return result;
    },
  };

  proxy.instance = new Proxy(target, handler);
  proxyCache.set(target, proxy);

  return proxy;
};

export const createRootProxy = <T extends object>(
  builder: (root: T) => T,
  options?: {
    callbacks: {
      get?: (target: T, prop: string | symbol, receiver: {}) => void;
      set?: (target: T, prop: string | symbol, value: unknown, receiver: {}) => void;
      deleteProperty?: (target: T, prop: string | symbol) => void;
    };
  }
): T => {
  let isBuilding = false;
  const skeleton = {} as T;
  const handler: ProxyHandler<T> = {
    get(target, prop, receiver) {
      if (prop === PROXY_UNWRAP_SYMBOL) return target;
      if (isBuilding) return Reflect.get(target, prop, receiver);

      if (!isBuilding) {
        options?.callbacks.get?.(target, prop, receiver);
      }

      const value = Reflect.get(target, prop, receiver);

      if (value && typeof value === "object") {
        return new Proxy(value, handler as ProxyHandler<{}>);
      }
      return value;
    },
    set(target, prop, value, receiver) {
      const result = Reflect.set(target, prop, value);

      if (!isBuilding) {
        options?.callbacks.set?.(target, prop, value, receiver);
      }

      return result;
    },
    deleteProperty(target, prop) {
      const result = Reflect.deleteProperty(target, prop);

      if (!isBuilding) {
        options?.callbacks.deleteProperty?.(target, prop);
      }

      return result;
    },
  };

  isBuilding = true;
  const root = builder(new Proxy(skeleton as T, handler));
  Object.assign(skeleton, root);
  isBuilding = false;

  return new Proxy(root, handler);
};

export const unwrapProxy = (proxy: {}) => {
  let root = proxy;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unwrapped = (root as any)[PROXY_UNWRAP_SYMBOL];
    if (!unwrapped) break;
    root = unwrapped;
  }
  return root;
};
