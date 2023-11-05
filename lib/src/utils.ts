export const isFunction = <T>(arg: T): arg is T & ((...args: unknown[]) => unknown) => {
  return typeof arg === "function";
};
