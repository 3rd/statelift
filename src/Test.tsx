import React from "react";
import { TestB } from "./TestB";
import { TestA } from "./TestA";
import { TestC } from "./TestC";

export const Test = () => {
  return (
    <div style={{ display: "flex", gap: "6rem" }}>
      <TestA />
      <TestB />
      <TestC />
    </div>
  );
};
