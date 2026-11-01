/**
 * Structured operational logs (architecture §9): one JSON object per
 * line with timestamp, service, level, event, and safe fields.
 *
 * NEVER log message content, chat/group names, credentials, API keys,
 * access tokens, phone numbers, session secrets, or the session
 * directory path (AGENTS.md). Field values passed to the logger must be
 * identifiers (JIDs, message ids), counts, codes, durations, or other
 * safe metadata only.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null>;

export type Logger = (
  level: LogLevel,
  event: string,
  fields?: LogFields,
) => void;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export function createLogger(service: string, minLevel: LogLevel = "info"): Logger {
  return (level, event, fields) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record = {
      time: new Date().toISOString(),
      service,
      level,
      event,
      ...fields,
    };
    const line = `${JSON.stringify(record)}\n`;
    if (level === "debug" || level === "info") {
      process.stdout.write(line);
    } else {
      process.stderr.write(line);
    }
  };
}

/** Logger that swallows everything (unit tests). */
export const silentLogger: Logger = () => {};
