export const isFunction = <T>(arg: T): arg is T & ((...args: unknown[]) => unknown) =>
  typeof arg === "function";

// Keep this exact accessor: bundlers replace it, while `typeof process` would pin browsers to development.
export const IS_DEV: boolean = (() => {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
})();

// Canonical array indices are decimal integers below 2**32 - 1 with no leading zero.
export const isArrayIndex = (key: string | symbol): key is string => {
  if (typeof key !== "string") return false;
  const length = key.length;
  if (length === 0 || length > 10) return false;
  const first = key.codePointAt(0);
  if (first === undefined) return false;
  if (first === 48) return length === 1;
  if (first < 48 || first > 57) return false;
  let index = first - 48;
  for (let position = 1; position < length; position++) {
    const code = key.codePointAt(position);
    if (code === undefined) return false;
    if (code < 48 || code > 57) return false;
    index = index * 10 + (code - 48);
  }
  return index < 4_294_967_295;
};
