import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasErrors,
  validateGroupForm,
  validateIanaTimeZone,
  validatePassword,
  validatePasswordConfirmation,
  validateProviderForm,
  validateRecoveryCode,
  validateSummaryTime,
} from "../src/lib/validation.ts";

test("password policy matches the contract minimum of 12 characters", () => {
  assert.notEqual(validatePassword("short"), null);
  assert.notEqual(validatePassword("elevenchars"), null);
  assert.equal(validatePassword("twelve-chars"), null);
  assert.notEqual(validatePassword("x".repeat(201)), null);
  assert.equal(validatePassword("x".repeat(200)), null);
});

test("password confirmation must match", () => {
  assert.notEqual(validatePasswordConfirmation("twelve-chars", ""), null);
  assert.notEqual(validatePasswordConfirmation("twelve-chars", "twelve-chars2"), null);
  assert.equal(validatePasswordConfirmation("twelve-chars", "twelve-chars"), null);
});

test("summary time accepts only HH:mm in 24 hour format", () => {
  assert.equal(validateSummaryTime("00:00"), null);
  assert.equal(validateSummaryTime("08:30"), null);
  assert.equal(validateSummaryTime("23:59"), null);
  assert.notEqual(validateSummaryTime("8:30"), null);
  assert.notEqual(validateSummaryTime("24:00"), null);
  assert.notEqual(validateSummaryTime("12:60"), null);
  assert.notEqual(validateSummaryTime(""), null);
});

test("time zone validation mirrors the contract IANA check", () => {
  assert.equal(validateIanaTimeZone("Europe/Madrid"), null);
  assert.equal(validateIanaTimeZone("UTC"), null);
  assert.equal(validateIanaTimeZone("  America/Bogota  "), null);
  assert.notEqual(validateIanaTimeZone(""), null);
  assert.notEqual(validateIanaTimeZone("Mars/Olympus"), null);
  assert.notEqual(validateIanaTimeZone("x".repeat(101)), null);
});

test("recovery code is required and bounded", () => {
  assert.notEqual(validateRecoveryCode("   "), null);
  assert.equal(validateRecoveryCode("abcd-efgh"), null);
  assert.notEqual(validateRecoveryCode("x".repeat(101)), null);
});

test("group form accepts a cleared summary time and rejects bad zones", () => {
  assert.equal(
    hasErrors(validateGroupForm({ timezone: "Europe/Madrid", summaryTime: null })),
    false,
  );
  assert.equal(
    hasErrors(validateGroupForm({ timezone: "Europe/Madrid", summaryTime: "07:45" })),
    false,
  );
  assert.equal(
    hasErrors(validateGroupForm({ timezone: "", summaryTime: "07:45" })),
    true,
  );
  assert.equal(
    hasErrors(validateGroupForm({ timezone: "Europe/Madrid", summaryTime: "7:45" })),
    true,
  );
});

test("provider form validates required fields, URL, and key length", () => {
  assert.equal(
    hasErrors(
      validateProviderForm({
        provider: "openai",
        model: "gpt-4o-mini",
        baseUrl: "",
        apiKey: "",
      }),
    ),
    false,
  );
  assert.equal(
    validateProviderForm({
      provider: "",
      model: "gpt-4o-mini",
      baseUrl: "",
      apiKey: "",
    }).provider !== undefined,
    true,
  );
  assert.equal(
    validateProviderForm({
      provider: "openai",
      model: "",
      baseUrl: "",
      apiKey: "",
    }).model !== undefined,
    true,
  );
  assert.equal(
    validateProviderForm({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "not a url",
      apiKey: "",
    }).baseUrl !== undefined,
    true,
  );
  assert.equal(
    validateProviderForm({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.example.com/v1",
      apiKey: "",
    }).baseUrl,
    undefined,
  );
  assert.equal(
    validateProviderForm({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "",
      apiKey: "k".repeat(501),
    }).apiKey !== undefined,
    true,
  );
});
