import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "bun:test";
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

  it("re-renders and reflects the new value when a property is set", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useProxyState<{ count: number }>({ count: 0 });
    });
    expect(renders).toBe(1);

    act(() => {
      result.current.count = 5;
    });

    expect(renders).toBe(2);
    expect(result.current.count).toBe(5);
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
});
