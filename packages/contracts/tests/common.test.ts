import { describe, expect, it } from "vitest";
import { ApiError, Id, Interval } from "../src/index.js";

describe("Interval (half-open: start inclusive, end exclusive)", () => {
  const base = {
    start: "2026-10-28T00:00:00Z",
    end: "2026-10-29T00:00:00Z",
    timezone: "Europe/Madrid",
  };

  it("accepts a valid interval", () => {
    expect(Interval.safeParse(base).success).toBe(true);
  });

  it("rejects end before start", () => {
    const result = Interval.safeParse({ ...base, end: "2026-10-27T00:00:00Z" });
    expect(result.success).toBe(false);
  });

  it("rejects a zero-length interval (end equal to start)", () => {
    const result = Interval.safeParse({ ...base, end: base.start });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid IANA time zone", () => {
    const result = Interval.safeParse({ ...base, timezone: "Not/AZone" });
    expect(result.success).toBe(false);
  });

  it("compares instants correctly across UTC offsets", () => {
    // start 2026-10-28T00:00+02:00 == 2026-10-27T22:00Z
    // end   2026-10-28T23:00Z is after that instant.
    const result = Interval.safeParse({
      start: "2026-10-28T00:00:00+02:00",
      end: "2026-10-28T23:00:00Z",
      timezone: "Europe/Madrid",
    });
    expect(result.success).toBe(true);
  });
});

describe("Id", () => {
  it("accepts a UUID", () => {
    expect(Id.safeParse("4f9d2b6a-1c31-4a2f-9a3e-9c0a1b2c3d4e").success).toBe(
      true,
    );
  });

  it("rejects a non-UUID string", () => {
    expect(Id.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("ApiError", () => {
  it("parses the standard error envelope", () => {
    const parsed = ApiError.parse({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        details: [{ path: "interval.end", message: "must be after start" }],
      },
    });
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.details).toHaveLength(1);
  });

  it("rejects an unknown error code", () => {
    const result = ApiError.safeParse({
      error: { code: "whoops", message: "x" },
    });
    expect(result.success).toBe(false);
  });
});
