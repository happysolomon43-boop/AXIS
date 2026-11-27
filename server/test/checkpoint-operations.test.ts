import { expect, test } from "vitest";
import {
  CHECKPOINT_OPERATIONS, checkpointLabelFor, isCheckpointOperation, type CheckpointOperation,
} from "../src/named-cuts/checkpoint-operations.js";

test("AXB-0113 AC1: only Restore has an automatic checkpoint name", () => {
  expect(Object.keys(CHECKPOINT_OPERATIONS)).toEqual(["restore"]);
  const label = CHECKPOINT_OPERATIONS.restore;
  expect(label).toBe("Before restore");
  expect(label).toMatch(/^[\u0000-\u007f]{1,200}$/);
  expect(label.trim()).toBe(label);
  expect(label).not.toContain("  ");
  expect(isCheckpointOperation("restore")).toBe(true);
  for (const value of ["toString", "Restore", "replace-all", undefined, 7]) {
    expect(isCheckpointOperation(value)).toBe(false);
  }
});

test("AXB-0113 AC2: name lookup checks own keys at runtime", () => {
  expect(checkpointLabelFor("restore")).toBe("Before restore");
  expect(() => checkpointLabelFor("replace-all" as CheckpointOperation))
    .toThrow(new Error("unknown checkpoint operation"));
});
