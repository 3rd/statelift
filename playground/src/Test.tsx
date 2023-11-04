import React from "react";
import { TestB } from "./TestB";
import { TestA } from "./TestA";
import { TestC } from "./TestC";
import { TestD } from "./TestD";

const tests = {
  a: true,
  b: true,
  c: true,
  d: true,
};

export const Test = () => {
  return (
    <div style={{ display: "flex", gap: "6rem" }}>
      {tests.a && <TestA />}
      {tests.b && <TestB />}
      {tests.c && <TestC />}
      {tests.d && <TestD />}
    </div>
  );
};
