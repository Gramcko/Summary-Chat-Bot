/**
 * Client-side validation that mirrors the `@summarly/contracts` rules:
 * `PasswordPolicy` (12–200), `SummaryTime` (`HH:mm`), `IanaTimeZone`, and the
 * provider configuration field limits. Server-side validation remains
 * authoritative; these checks only avoid obviously invalid round trips.
 */

export type FieldErrors = Record<string, string>;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;
export const MAX_TIME_ZONE_LENGTH = 100;

/** `SummaryTime` from the contract, kept in sync by hand. */
export const SUMMARY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validatePassword(value: string): string | null {
  if (value.length === 0) return "A password is required.";
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

export function validatePasswordConfirmation(
  password: string,
  confirmation: string,
): string | null {
  if (confirmation.length === 0) return "Repeat the password.";
  if (confirmation !== password) return "The passwords do not match.";
  return null;
}

export function validateIanaTimeZone(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "A time zone is required.";
  if (trimmed.length > MAX_TIME_ZONE_LENGTH) {
    return `Use at most ${MAX_TIME_ZONE_LENGTH} characters.`;
  }
  if (!isValidIanaTimeZone(trimmed)) {
    return "Enter a valid IANA time zone name (for example Europe/Madrid).";
  }
  return null;
}

export function validateSummaryTime(value: string): string | null {
  if (value.length === 0) return "Enter a time (for example 08:30).";
  if (!SUMMARY_TIME_PATTERN.test(value)) {
    return "Enter a 24-hour time in HH:mm format (for example 08:30).";
  }
  return null;
}

export function validateRecoveryCode(value: string): string | null {
  if (value.trim().length === 0) return "A recovery code is required.";
  if (value.trim().length > 100) return "Use at most 100 characters.";
  return null;
}

export interface GroupFormValues {
  timezone: string;
  /** `null` means "no daily cutoff" (sent as `summaryTime: null`). */
  summaryTime: string | null;
}

export function validateGroupForm(values: GroupFormValues): FieldErrors {
  const errors: FieldErrors = {};
  const timezoneError = validateIanaTimeZone(values.timezone);
  if (timezoneError !== null) errors.timezone = timezoneError;
  if (values.summaryTime !== null) {
    const summaryTimeError = validateSummaryTime(values.summaryTime);
    if (summaryTimeError !== null) errors.summaryTime = summaryTimeError;
  }
  return errors;
}

export interface ProviderFormValues {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export function validateProviderForm(values: ProviderFormValues): FieldErrors {
  const errors: FieldErrors = {};

  const provider = values.provider.trim();
  if (provider.length === 0) errors.provider = "A provider is required.";
  else if (provider.length > 100) errors.provider = "Use at most 100 characters.";

  const model = values.model.trim();
  if (model.length === 0) errors.model = "A model is required.";
  else if (model.length > 200) errors.model = "Use at most 200 characters.";

  const baseUrl = values.baseUrl.trim();
  if (baseUrl.length > 0) {
    if (baseUrl.length > 500) {
      errors.baseUrl = "Use at most 500 characters.";
    } else if (!isAbsoluteUrl(baseUrl)) {
      errors.baseUrl = "Enter a valid absolute URL (for example https://api.example.com/v1).";
    }
  }

  if (values.apiKey.length > 500) errors.apiKey = "Use at most 500 characters.";

  return errors;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
