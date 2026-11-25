/// <reference lib="es2024.string" />

import { AppError } from "../errors.js";

const maxContentLength = 1_000_000;

function validationError(path: string, message: string): AppError {
  return new AppError(400, "validation_failed", "Request validation failed", {
    errors: [{ path, message }],
  });
}

export function invalidHints(): AppError {
  return validationError(
    "/hints",
    "must be null or an array with at most one element per scene; each element is null or an object with only pov, location, time and time_mode; pov, location and time are null or 1 to 200 characters; time_mode is null or one of linear, flashback, skip, loop",
  );
}

export function invalidParentVersion(): AppError {
  return validationError("/parent_version", "must be the id of a version of this chapter");
}

function exceedsContentLimit(content: string): boolean {
  if (content.length <= maxContentLength) return false;
  let length = 0;
  for (const _ of content) {
    length += 1;
    if (length > maxContentLength) return true;
  }
  return false;
}

function hasInvalidText(value: string): boolean {
  return !value.isWellFormed() || value.includes("\u0000");
}

export function checkContent(content: string): void {
  if (content.length > 2 * maxContentLength || hasInvalidText(content) || exceedsContentLimit(content)) {
    throw validationError("/content", "must be at most 1000000 characters and must not contain NUL or unpaired surrogates");
  }
}

export function checkHintsText(hints: unknown[] | null | undefined): void {
  if (!hints) return;

  const stack: unknown[] = [hints];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (hasInvalidText(value)) throw invalidHints();
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (hasInvalidText(key)) throw invalidHints();
        stack.push(item);
      }
    }
  }
}
