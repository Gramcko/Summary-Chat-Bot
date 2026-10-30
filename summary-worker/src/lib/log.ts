/**
 * Structured operational logs (architecture §9): one JSON object per
 * line with timestamp, service, level, event, and run/job identifiers.
 *
 * NEVER log message content, credentials, API keys, access tokens, or
 * session secrets (AGENTS.md). Field values passed to the logger must be
 * identifiers, counts, codes, or other safe metadata only.
 */
export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null>;

export type Logger = (
  level: LogLevel,
  event: string,
  fields?: LogFields,
) => void;

export function createLogger(service: string): Logger {
  return (level, event, fields) => {
    const record = {
      time: new Date().toISOString(),
      service,
      level,
      event,
      ...fields,
    };
    const line = `${JSON.stringify(record)}\n`;
    if (level === "info") {
      process.stdout.write(line);
    } else {
      process.stderr.write(line);
    }
  };
}

/** Logger that swallows everything (unit tests). */
export const silentLogger: Logger = () => {};
