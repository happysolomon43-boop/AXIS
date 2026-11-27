import { expect, test } from "vitest";
import {
  CHECKPOINT_OPERATIONS, checkpointLabelFor, isCheckpointOperation, type CheckpointOperation,
} from "../src/named-cuts/checkpoint-operations.js";

test("AXB-0113 AC1: Restore and Keep mine have distinct automatic checkpoint names", () => {
  expect(Object.keys(CHECKPOINT_OPERATIONS)).toEqual(["restore", "keep_mine"]);
  const label = CHECKPOINT_OPERATIONS.restore;
  expect(label).toBe("Before restore");
  expect(label).toMatch(/^[\u0000-\u007f]{1,200}$/);
  expect(label.trim()).toBe(label);
  expect(label).not.toContain("  ");
  expect(isCheckpointOperation("restore")).toBe(true);
  expect(isCheckpointOperation("keep_mine")).toBe(true);
  expect(CHECKPOINT_OPERATIONS.keep_mine).toBe("Before conflict resolution");
  expect(CHECKPOINT_OPERATIONS.keep_mine).toMatch(/^[\u0000-\u007f]{1,200}$/);
  for (const value of ["toString", "Restore", "replace-all", undefined, 7]) {
    expect(isCheckpointOperation(value)).toBe(false);
  }
});

test("AXB-0113 AC2: name lookup checks own keys at runtime", () => {
  expect(checkpointLabelFor("restore")).toBe("Before restore");
  expect(checkpointLabelFor("keep_mine")).toBe("Before conflict resolution");
  expect(() => checkpointLabelFor("replace-all" as CheckpointOperation))
    .toThrow(new Error("unknown checkpoint operation"));
});
