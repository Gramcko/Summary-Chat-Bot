import assert from "node:assert/strict";
import { test } from "node:test";
import { hasFieldErrors, mapFieldErrors, normalizeFieldPath } from "../src/lib/form-errors.ts";

test("field paths are reduced to the field name", () => {
  assert.equal(normalizeFieldPath("password"), "password");
  assert.equal(normalizeFieldPath("body.timezone"), "timezone");
  assert.equal(normalizeFieldPath("interval.start"), "start");
  assert.equal(normalizeFieldPath("interval"), "interval");
  assert.equal(normalizeFieldPath("tasks[0].text"), "text");
});

test("server details are mapped onto form fields", () => {
  const errors = mapFieldErrors([
    { path: "interval.timezone", message: "must be a valid IANA time zone name" },
    { path: "interval.end", message: "end must be after start" },
    { path: "timezone", message: "duplicate is ignored" },
  ]);
  assert.deepEqual(errors, {
    timezone: "must be a valid IANA time zone name",
    end: "end must be after start",
  });
});

test("missing details produce no field errors", () => {
  assert.deepEqual(mapFieldErrors(undefined), {});
  assert.deepEqual(mapFieldErrors([]), {});
  assert.equal(
    hasFieldErrors({ timezone: "bad" }, ["timezone", "summaryTime"]),
    true,
  );
  assert.equal(hasFieldErrors({}, ["timezone"]), false);
});
