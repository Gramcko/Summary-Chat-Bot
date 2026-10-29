"use client";

import { useMemo } from "react";
import { supportedTimeZones } from "@/lib/format";

export const TIME_ZONE_LIST_ID = "iana-time-zones";

/**
 * `<datalist>` of IANA time zone names for the time zone inputs on this page.
 * Render it once per page that contains a time zone field.
 */
export function IanaTimeZoneOptions() {
  const zones = useMemo(() => supportedTimeZones(), []);
  return (
    <datalist id={TIME_ZONE_LIST_ID}>
      {zones.map((zone) => (
        <option key={zone} value={zone} />
      ))}
    </datalist>
  );
}
