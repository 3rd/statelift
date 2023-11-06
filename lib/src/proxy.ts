/* eslint-disable no-param-reassign */
const PROXY_ID_SYMBOL = Symbol("type");

export type ProxyCallbacks = {
  get: (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: unknown) => void;
  set: (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: unknown) => void;
  delete: (proxy: ProxyCacheValue, target: {}, key: string | symbol) => void;
};

export type ProxyCacheValue<T extends {} = {}> = {
  instance: T;
  callbacks?: Partial<ProxyCallbacks>;
  rootInstance?: ProxyCacheValue;
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
  const { rootSymbol = Symbol(`state-proxy:${count++}`), callbacks = {}, rootProxy } = options;
  const isRoot = options.isRoot !== false;

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
    instance: null as unknown as T,
    rootInstance: isRoot ? undefined : rootProxy,
    callbacks,
    [PROXY_ID_SYMBOL]: rootSymbol,
  };

  const rootInstance = isRoot ? proxy : rootProxy!;

  const nextOptions = {
    rootSymbol,
    rootProxy: rootInstance,
    isRoot: false,
  };

  const handler: ProxyHandler<T> = {
    get(obj, prop, receiver) {
      console.log("@proxy get", rootSymbol, prop, { rootInstance });
      const value = Reflect.get(obj, prop, receiver);

      rootInstance.callbacks!.get?.(proxy, obj, prop, value);

      if (value && typeof value === "object") {
        return createDeepProxy(value, nextOptions).instance;
      }
      return value;
    },
    set(obj, prop, value, receiver) {
      // console.log("@proxy set", { proxy, target: obj, prop, value });
      Reflect.set(obj, prop, value, receiver);
      rootInstance.callbacks!.set?.(proxy, obj, prop, value);
      return true;
    },
    deleteProperty(obj, prop) {
      // console.log("@proxy deleteProperty", { proxy, target: obj, prop });
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete obj[prop as keyof T];
      rootInstance.callbacks!.delete?.(proxy, obj, prop);
      return true;
    },
  };

  proxy.instance = new Proxy(target, handler);
  proxyCache.set(target, proxy);

  return proxy;
};
