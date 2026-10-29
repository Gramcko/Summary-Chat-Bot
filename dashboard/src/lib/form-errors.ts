import type { ErrorDetail } from "@summarly/contracts";
import type { FieldErrors } from "./validation";

/**
 * Turns `error.details[].path` values from the standard error envelope into
 * per-field form errors.
 *
 * The backend builds paths from Zod issue paths, e.g. `interval.start` or
 * `groupId`; forms key their errors by the field name, so the last path
 * segment wins (`interval.start` → `start`).
 */
export function normalizeFieldPath(path: string): string {
  const withoutBody = path.replace(/^body\./, "");
  const segments = withoutBody.split(".").filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last ?? withoutBody;
}

export function mapFieldErrors(
  details: readonly ErrorDetail[] | undefined,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const detail of details ?? []) {
    const key = normalizeFieldPath(detail.path);
    if (key.length === 0) continue;
    if (errors[key] === undefined) errors[key] = detail.message;
  }
  return errors;
}

/** True when a server error is relevant to at least one known form field. */
export function hasFieldErrors(
  errors: FieldErrors,
  fieldNames: readonly string[],
): boolean {
  return fieldNames.some((name) => errors[name] !== undefined);
}
