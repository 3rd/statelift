import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "bun:test";
import { uncached } from "../store";
import { useProxyState } from "./useProxyState";

describe("useProxyState", () => {
  it("returns a deep proxy that is stable across re-renders", () => {
    const target = { count: 0 };
    const { result, rerender } = renderHook(() => useProxyState(target));

    expect(result.current).not.toBe(target);
    expect(result.current).toEqual(target);

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("re-renders when a nested property is set", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useProxyState({ nested: { value: 1 } });
    });

    act(() => {
      result.current.nested.value = 2;
    });

    expect(renders).toBe(2);
    expect(result.current.nested.value).toBe(2);
  });

  it("re-renders when a property is deleted", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useProxyState<{ a?: number }>({ a: 1 });
    });

    act(() => {
      delete result.current.a;
    });

    expect(renders).toBe(2);
    expect(result.current.a).toBeUndefined();
  });

  it("re-renders once for an effective compound array mutation", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useProxyState<{ items: number[] }>({ items: [] });
    });

    act(() => {
      result.current.items.push(1);
    });

    expect(renders).toBe(2);
    expect(result.current.items).toEqual([1]);
  });

  it("does not re-render for compound array no-ops", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useProxyState<{ items: number[] }>({ items: [] });
    });

    act(() => {
      result.current.items.pop();
      result.current.items.push();
    });

    expect(renders).toBe(1);
  });
});

describe("useProxyState computed caching", () => {
  it("runs a getter once per version, not once per read", () => {
    let runs = 0;
    const { result } = renderHook(() =>
      useProxyState({
        n: 2,
        get dbl() {
          runs++;
          return this.n * 2;
        },
      }),
    );

    expect(result.current.dbl).toEqual(4);
    expect(result.current.dbl).toEqual(4);
    expect(runs).toEqual(1);

    act(() => {
      result.current.n = 3;
    });
    expect(result.current.dbl).toEqual(6);
    expect(result.current.dbl).toEqual(6);
    expect(runs).toEqual(2);
  });

  it("caches nested getters discovered on wrap", () => {
    let runs = 0;
    const { result } = renderHook(() =>
      useProxyState({
        mod: {
          v: 1,
          get squared() {
            runs++;
            return this.v * this.v;
          },
        },
      }),
    );

    expect(result.current.mod.squared).toEqual(1);
    expect(result.current.mod.squared).toEqual(1);
    expect(runs).toEqual(1);
  });

  it("honors uncached()", () => {
    let runs = 0;
    const base: { n: number; readonly fresh?: number } = { n: 1 };
    Object.defineProperty(base, "fresh", {
      configurable: true,
      enumerable: true,
      get: uncached(() => {
        runs++;
        return base.n;
      }),
    });
    const { result } = renderHook(() => useProxyState(base));

    expect(result.current.fresh).toEqual(1);
    expect(result.current.fresh).toEqual(1);
    expect(runs).toEqual(2);
  });

  it("reconciles a cached getter when it becomes data or is deleted", () => {
    const target: { value?: number } = {};
    Object.defineProperty(target, "value", { configurable: true, get: () => 1 });
    const { result } = renderHook(() => useProxyState(target));
    expect(result.current.value).toBe(1);

    act(() => {
      Object.defineProperty(result.current, "value", {
        value: 5,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    });
    expect(result.current.value).toBe(5);

    act(() => {
      delete result.current.value;
    });
    expect(result.current.value).toBeUndefined();
  });

  it("does not report a cycle for one getter shared across nodes", () => {
    type SharedNode = { other?: SharedNode; value?: number };
    const sharedGetter = function (this: SharedNode) {
      return this.other ? (this.other.value ?? 0) + 1 : 1;
    };
    const b: SharedNode = {};
    Object.defineProperty(b, "value", { configurable: true, enumerable: true, get: sharedGetter });
    const a: SharedNode = { other: b };
    Object.defineProperty(a, "value", { configurable: true, enumerable: true, get: sharedGetter });
    const { result } = renderHook(() => useProxyState({ a, b }));

    expect(result.current.a.value).toBe(2);
    expect(result.current.b.value).toBe(1);
  });

  it("throws on a real computed cycle", () => {
    const node: { a?: number; b?: number } = {};
    Object.defineProperty(node, "a", {
      configurable: true,
      enumerable: true,
      get(this: { b?: number }) {
        return this.b;
      },
    });
    Object.defineProperty(node, "b", {
      configurable: true,
      enumerable: true,
      get(this: { a?: number }) {
        return this.a;
      },
    });
    const { result } = renderHook(() => useProxyState(node));

    expect(() => result.current.a).toThrow(/computed cycle/);
  });

  it("caches non-enumerable and symbol getters", () => {
    const symbol = Symbol("computed");
    let runs = 0;
    const target: { hidden?: number; [symbol]?: number } = {};
    Object.defineProperty(target, "hidden", {
      configurable: true,
      get() {
        runs++;
        return 1;
      },
    });
    Object.defineProperty(target, symbol, {
      configurable: true,
      get() {
        runs++;
        return 2;
      },
    });
    const { result } = renderHook(() => useProxyState(target));

    expect(result.current.hidden).toBe(1);
    expect(result.current.hidden).toBe(1);
    expect(result.current[symbol]).toBe(2);
    expect(result.current[symbol]).toBe(2);
    expect(runs).toBe(2);
  });
});
