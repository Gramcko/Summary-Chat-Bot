import { z } from "zod";

/** Universally unique identifier used for all persisted entities. */
export const Id = z.uuid();

/** ISO 8601 timestamp with offset. Server-generated values are always UTC. */
export const IsoDateTime = z.iso.datetime({ offset: true });

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Explicit IANA time zone name. Never rely on the host's local time zone. */
export const IanaTimeZone = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidTimeZone, "must be a valid IANA time zone name");

/**
 * Half-open time interval: `start` inclusive, `end` exclusive.
 * Every summary period uses this shape so adjacent periods never overlap
 * or double-count messages.
 */
export const Interval = z
  .object({
    start: IsoDateTime,
    end: IsoDateTime,
    timezone: IanaTimeZone,
  })
  .refine(
    (interval) => Date.parse(interval.end) > Date.parse(interval.start),
    "end must be after start (half-open interval: start inclusive, end exclusive)",
  );

export const ErrorCode = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
]);

export const ErrorDetail = z.object({
  path: z.string(),
  message: z.string(),
});

/** Standard error envelope returned by every failing API response. */
export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.array(ErrorDetail).optional(),
  }),
});

export type Id = z.infer<typeof Id>;
export type IsoDateTime = z.infer<typeof IsoDateTime>;
export type IanaTimeZone = z.infer<typeof IanaTimeZone>;
export type Interval = z.infer<typeof Interval>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type ErrorDetail = z.infer<typeof ErrorDetail>;
export type ApiError = z.infer<typeof ApiError>;
