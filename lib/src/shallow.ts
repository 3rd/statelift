export const shallow = <T>(left: T, right: T): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (const [index, element] of left.entries()) {
      if (!Object.is(element, right[index])) return false;
    }
    return true;
  }

  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (
    (leftPrototype !== Object.prototype && leftPrototype !== null) ||
    (rightPrototype !== Object.prototype && rightPrototype !== null)
  ) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !Object.is(Reflect.get(left, key), Reflect.get(right, key))) {
      return false;
    }
  }
  return true;
};
