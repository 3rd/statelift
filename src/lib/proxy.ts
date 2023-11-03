/* eslint-disable no-param-reassign */

const SYMBOL_KEY = Symbol("symbol");

type ProxyCallbacks = {
  get?: (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: unknown) => void;
  set?: (proxy: ProxyCacheValue, target: {}, key: string | symbol, value: unknown) => void;
  delete?: (proxy: ProxyCacheValue, target: {}, key: string | symbol) => void;
};

export type ProxyCacheValue = {
  instance: {};
  rootInstance?: ProxyCacheValue;
  callbacks?: ProxyCallbacks;
};
const cache = new Map<symbol, WeakMap<{}, ProxyCacheValue>>();

type CreateDeepProxyOptions = {
  rootSymbol?: symbol;
  isRoot?: boolean;
  rootProxy?: ProxyCacheValue;
  callbacks?: ProxyCallbacks;
};
let count = 0;
export const createDeepProxy = <T extends {}>(target: T, options: CreateDeepProxyOptions = {}): T => {
  const { rootSymbol = Symbol(`root-proxy:${count++}`), callbacks = {}, rootProxy } = options;
  const isRoot = options.isRoot !== false;

  // console.log("@createDeepProxy", { target, options, rootSymbol, isRoot });

  let rootCache = cache.get(rootSymbol);
  if (!rootCache) {
    // console.log("@create root cache", { rootSymbol });
    rootCache = new WeakMap();
    cache.set(rootSymbol, rootCache);
  }

  const cachedProxy = rootCache.get(target);

  if (cachedProxy) {
    // console.log("@cached", { cachedProxy });
    if (isRoot && callbacks) cachedProxy.callbacks = callbacks;
    return cachedProxy.instance as T;
  }

  // console.log("@create", { target, options, rootSymbol });

  const proxy: ProxyCacheValue = {
    instance: null as unknown as {},
    callbacks,
    rootInstance: isRoot ? undefined : rootProxy,
  };

  const rootInstance = isRoot ? proxy : rootProxy!;

  const nextOptions: CreateDeepProxyOptions = {
    rootSymbol,
    rootProxy: rootInstance,
    isRoot: false,
  };

  const handler: ProxyHandler<T> = {
    get(obj, prop) {
      // console.log("@proxy get", { target: obj, prop, rootInstance, options });
      const value = Reflect.get(obj, prop);

      rootInstance.callbacks!.get?.(proxy, obj, prop, value);

      if (value && typeof value === "object") {
        return createDeepProxy(value, nextOptions);
      }

      return value;
    },

    set(obj, prop, value) {
      // console.log("@proxy set", { target: obj, prop, value, rootInstance, options });

      if (value && typeof value === "object") {
        obj[prop as keyof T] = { ...obj[prop as keyof T], ...value };
      } else {
        obj[prop as keyof T] = value;
      }

      rootInstance.callbacks!.set?.(proxy, obj, prop, value);
      return true;
    },

    deleteProperty(obj, prop) {
      // console.log("@proxy deleteProperty", { target: obj, prop, rootInstance, options });

      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete obj[prop as keyof T];
      rootInstance.callbacks!.delete?.(proxy, obj, prop);

      return true;
    },
  };

  proxy.instance = new Proxy(target, handler);
  Object.defineProperty(proxy, SYMBOL_KEY, { value: rootSymbol });
  rootCache.set(target, proxy);
  // rootCache.set(proxy.instance, proxy);

  return proxy.instance as T;
};
