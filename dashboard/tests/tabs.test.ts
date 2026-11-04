import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTabIndex } from "../src/lib/tabs.ts";

test("arrow keys move focus and wrap around", () => {
  assert.equal(nextTabIndex(0, "ArrowRight", 4), 1);
  assert.equal(nextTabIndex(3, "ArrowRight", 4), 0);
  assert.equal(nextTabIndex(0, "ArrowLeft", 4), 3);
  assert.equal(nextTabIndex(2, "ArrowLeft", 4), 1);
});

test("Home and End jump to the first and last tab", () => {
  assert.equal(nextTabIndex(2, "Home", 4), 0);
  assert.equal(nextTabIndex(1, "End", 4), 3);
});

test("other keys and empty tab sets are ignored", () => {
  assert.equal(nextTabIndex(0, "Enter", 4), null);
  assert.equal(nextTabIndex(0, "Tab", 4), null);
  assert.equal(nextTabIndex(0, "ArrowRight", 0), null);
  assert.equal(nextTabIndex(0, "ArrowRight", 1), 0);
});
