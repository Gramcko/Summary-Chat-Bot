import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSTRUCTIONS_MAX_LENGTH,
  normalizeInstructions,
  validateInstructions,
} from "../src/lib/instructions.ts";

test("instructions are optional and trimmed before sending", () => {
  assert.equal(normalizeInstructions(""), undefined);
  assert.equal(normalizeInstructions("   \n "), undefined);
  assert.equal(normalizeInstructions("  focus on decisions  "), "focus on decisions");
});

test("instructions are capped at the contract limit", () => {
  assert.equal(INSTRUCTIONS_MAX_LENGTH, 2000);
  assert.equal(validateInstructions(""), null);
  assert.equal(validateInstructions("  "), null);
  assert.equal(validateInstructions("x".repeat(2000)), null);
  assert.equal(validateInstructions(`  ${"x".repeat(2000)}  `), null);
  assert.match(String(validateInstructions("x".repeat(2001))), /at most 2000/);
});
