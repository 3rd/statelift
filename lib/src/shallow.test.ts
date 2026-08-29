import { describe, expect, it } from "bun:test";
import { shallow } from "./shallow";

describe("shallow", () => {
  it("compares primitives via Object.is", () => {
    expect(shallow(Number.NaN, Number.NaN)).toBe(true);
    expect(shallow(0, -0)).toBe(false);
  });

  it("compares arrays one level deep", () => {
    expect(shallow([1, 2], [1, 2])).toBe(true);
    expect(shallow([1, 2], [1, 3])).toBe(false);
    expect(shallow([1, 2], [1, 2, 3])).toBe(false);

    expect(shallow([{ a: 1 }], [{ a: 1 }])).toBe(false);
    const nested = { a: 1 };
    expect(shallow([nested], [nested])).toBe(true);
  });

  it("compares plain objects by own enumerable string keys", () => {
    expect(shallow({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(shallow({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
    expect(shallow<Record<string, number>>({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallow<Record<string, number>>({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
  });

  it("excludes symbol keys from the comparison", () => {
    const symbol = Symbol("k");
    expect(shallow({ a: 1, [symbol]: 1 }, { a: 1, [symbol]: 2 })).toBe(true);
  });

  it("mixed shapes and non-plain inputs fall back to identity", () => {
    expect(shallow<unknown>([1], { 0: 1 })).toBe(false);
    expect(shallow(new Date(0), new Date(0))).toBe(false);
  });
});
