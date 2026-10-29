import { z } from "zod";
import type { ApiError, ErrorCode, ErrorDetail } from "@summarly/contracts";

/** HTTP error carrying the public error envelope data. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
    /** Extra response headers (e.g. Retry-After on 429). */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function apiError(
  code: ErrorCode,
  message: string,
  details?: ErrorDetail[],
): ApiError {
  return { error: details ? { code, message, details } : { code, message } };
}

export function zodDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    message: issue.message,
  }));
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};
