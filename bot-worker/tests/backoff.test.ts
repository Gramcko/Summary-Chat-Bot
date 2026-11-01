import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "../src/backoff.js";

const POLICY = { baseMs: 1_000, capMs: 60_000 };

describe("reconnectDelayMs (capped exponential backoff)", () => {
  it("waits baseMs on the first attempt", () => {
    expect(reconnectDelayMs(1, POLICY)).toBe(1_000);
  });

  it("doubles the delay per attempt", () => {
    expect(reconnectDelayMs(2, POLICY)).toBe(2_000);
    expect(reconnectDelayMs(3, POLICY)).toBe(4_000);
    expect(reconnectDelayMs(5, POLICY)).toBe(16_000);
  });

  it("caps the delay", () => {
    expect(reconnectDelayMs(7, POLICY)).toBe(60_000);
    expect(reconnectDelayMs(8, POLICY)).toBe(60_000);
  });

  it("never overflows on absurd attempt counts", () => {
    expect(reconnectDelayMs(1_000, POLICY)).toBe(60_000);
  });

  it("treats attempt 0 as attempt 1", () => {
    expect(reconnectDelayMs(0, POLICY)).toBe(1_000);
    expect(reconnectDelayMs(-5, POLICY)).toBe(1_000);
  });

  it("honors a custom policy (tiny delays for tests)", () => {
    expect(reconnectDelayMs(1, { baseMs: 5, capMs: 20 })).toBe(5);
    expect(reconnectDelayMs(2, { baseMs: 5, capMs: 20 })).toBe(10);
    expect(reconnectDelayMs(3, { baseMs: 5, capMs: 20 })).toBe(20);
    expect(reconnectDelayMs(4, { baseMs: 5, capMs: 20 })).toBe(20);
  });
});
