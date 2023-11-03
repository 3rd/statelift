type ProxyCallbacks = {
  onGet?: (path: string) => void;
  onSet?: (path: string, value: any) => void;
  onDelete?: (path: string) => void;
};

type ProxyCacheValue = {
  instance: {};
  rootInstance?: ProxyCacheValue;
  callbacks?: ProxyCallbacks;
};
const cache = new WeakMap<{}, ProxyCacheValue>();

window.cache = cache;

type CreateDeepProxyOptions = ProxyCallbacks & {
  taintSymbol?: symbol;
};
export const createDeepProxy = <T extends {}>(
  target: T,
  options?: CreateDeepProxyOptions,
  rootProxy?: ProxyCacheValue
): T => {
  const cachedProxy = cache.get(target);

  if (cachedProxy) {
    // if (!rootProxy) {
    //   if (cachedProxy.callbacks!.onGet !== options?.onGet && options?.onGet) {
    //     cachedProxy.callbacks!.onGet = options?.onGet;
    //   }
    //   if (cachedProxy.callbacks!.onSet !== options?.onSet && options?.onSet) {
    //     cachedProxy.callbacks!.onSet = options?.onSet;
    //   }
    //   if (cachedProxy.callbacks!.onDelete !== options?.onDelete && options?.onDelete) {
    //     cachedProxy.callbacks!.onDelete = options?.onDelete;
    //   }
    // }

    return cachedProxy.instance as T;
  }

  let proxy: ProxyCacheValue = {
    instance: null as unknown as {},
  };

  if (rootProxy) {
    proxy.rootInstance = rootProxy;
  } else {
    proxy.callbacks = { onGet: options?.onGet, onSet: options?.onSet, onDelete: options?.onDelete };
  }

  const handler: ProxyHandler<T> = {
    get(target, prop) {
      (rootProxy?.callbacks ?? proxy.callbacks)!.onGet?.(prop.toString());
      const value = Reflect.get(target, prop);
      if (value && typeof value === "object") {
        return createDeepProxy(value, options, rootProxy ?? proxy);
      }
      return value;
    },
    set(target, prop, value) {
      if (typeof target[prop as keyof T] === "object" && typeof value === "object") {
        target[prop as keyof T] = createDeepProxy(
          { ...target[prop as keyof T], ...value },
          options,
          rootProxy ?? proxy
        );
      } else {
        target[prop as keyof T] = value;
      }
      (rootProxy?.callbacks ?? proxy.callbacks)!.onSet?.(prop.toString(), value);
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop as keyof T];
      (rootProxy?.callbacks ?? proxy.callbacks)!.onDelete?.(prop.toString());
      return true;
    },
  };

  proxy.instance = new Proxy(target, handler);
  cache.set(target, proxy);

  return proxy.instance as T;
};
