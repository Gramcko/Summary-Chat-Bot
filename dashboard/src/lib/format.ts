import type { Group, SummaryRun } from "@summarly/contracts";

/** Display name for a run's group, falling back to a shortened id. */
export function groupName(
  groups: readonly Group[] | null | undefined,
  groupId: string,
): string {
  const match = groups?.find((group) => group.id === groupId);
  return match === undefined ? `Group ${groupId.slice(0, 8)}` : match.name;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return count === 1 ? singular : plural;
}

/** True while a run is queued or being processed (worth polling). */
export function isRunInProgress(run: SummaryRun | null): boolean {
  return run?.status === "pending" || run?.status === "processing";
}

/** IANA time zone suggestions for `<datalist>`; empty when unsupported. */
export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  if (typeof intl.supportedValuesOf !== "function") return [];
  try {
    return intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}
