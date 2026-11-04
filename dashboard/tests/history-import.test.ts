import assert from "node:assert/strict";
import { test } from "node:test";
import type { Group, GroupHistoryImport } from "@summarly/contracts";
import {
  anyHistoryImportInFlight,
  historyImportInFlight,
  isHistoryImportStalled,
  requiresHistoryImportPrompt,
  summarizeHistoryImport,
} from "../src/lib/history-import.ts";

function importState(
  overrides: Partial<GroupHistoryImport> = {},
): GroupHistoryImport {
  return {
    status: "pending",
    requestedAt: "2026-11-02T09:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    importedCount: 0,
    error: null,
    ...overrides,
  };
}

function group(
  id: string,
  historyImport: GroupHistoryImport | null,
): Group {
  return {
    id,
    chatId: null,
    name: `Group ${id}`,
    monitored: true,
    timezone: "Europe/Madrid",
    summaryTime: null,
    historyImport,
  };
}

test("only turning monitoring ON asks about old messages", () => {
  assert.equal(requiresHistoryImportPrompt(false, true), true);
  assert.equal(requiresHistoryImportPrompt(true, false), false);
  assert.equal(requiresHistoryImportPrompt(true, true), false);
  assert.equal(requiresHistoryImportPrompt(false, false), false);
});

test("in-flight detection covers pending and running only", () => {
  assert.equal(historyImportInFlight(null), false);
  assert.equal(historyImportInFlight(importState({ status: "pending" })), true);
  assert.equal(historyImportInFlight(importState({ status: "running" })), true);
  assert.equal(historyImportInFlight(importState({ status: "done" })), false);
  assert.equal(historyImportInFlight(importState({ status: "failed" })), false);
});

test("polling is driven by any group with a pending/running import", () => {
  assert.equal(anyHistoryImportInFlight(null), false);
  assert.equal(anyHistoryImportInFlight(undefined), false);
  assert.equal(anyHistoryImportInFlight([]), false);
  assert.equal(
    anyHistoryImportInFlight([
      group("a", null),
      group("b", importState({ status: "done" })),
      group("c", importState({ status: "failed" })),
    ]),
    false,
  );
  assert.equal(
    anyHistoryImportInFlight([
      group("a", null),
      group("b", importState({ status: "running" })),
    ]),
    true,
  );
});

test("no summary when history was never imported", () => {
  assert.equal(summarizeHistoryImport(null), null);
});

test("pending import shows the importing copy and a start hint", () => {
  // Fixed clock: a fresh request (the stall hint has its own test below).
  const summary = summarizeHistoryImport(
    importState({ status: "pending" }),
    Date.parse("2026-11-02T09:05:00.000Z"),
  );

  assert.ok(summary !== null);
  assert.equal(summary.inFlight, true);
  assert.equal(summary.badgeLabel, "Importing");
  assert.equal(summary.message, "Importing old messages…");
  assert.match(String(summary.detail), /waiting for the bot worker/i);
  assert.equal(summary.hint, null);
  assert.equal(summary.showRetry, false);
});

test("stuck pending imports get a 'check the bot worker' hint", () => {
  const requestedAt = "2026-11-02T09:00:00.000Z";
  const requestedMs = Date.parse(requestedAt);

  assert.equal(isHistoryImportStalled(null, requestedMs), false);
  assert.equal(
    isHistoryImportStalled(importState({ status: "running" }), requestedMs + 60 * 60 * 1000),
    false,
  );
  assert.equal(
    isHistoryImportStalled(importState({ status: "pending" }), requestedMs + 9 * 60 * 1000),
    false,
  );
  assert.equal(
    isHistoryImportStalled(importState({ status: "pending" }), requestedMs + 10 * 60 * 1000),
    false,
  );
  assert.equal(
    isHistoryImportStalled(importState({ status: "pending" }), requestedMs + 11 * 60 * 1000),
    true,
  );

  const stuck = summarizeHistoryImport(
    importState({ status: "pending" }),
    requestedMs + 11 * 60 * 1000,
  );
  const fresh = summarizeHistoryImport(
    importState({ status: "pending" }),
    requestedMs + 60 * 1000,
  );
  const runningForAWhile = summarizeHistoryImport(
    importState({ status: "running" }),
    requestedMs + 60 * 60 * 1000,
  );

  assert.ok(stuck !== null && fresh !== null && runningForAWhile !== null);
  assert.equal(
    stuck.hint,
    "Still waiting for the bot worker — check that it is running.",
  );
  assert.equal(fresh.hint, null);
  // A running import is making progress; no stall hint there.
  assert.equal(runningForAWhile.hint, null);
});

test("running import reports the last known count", () => {
  const waiting = summarizeHistoryImport(
    importState({ status: "running", importedCount: 0 }),
  );
  const partial = summarizeHistoryImport(
    importState({ status: "running", importedCount: 12 }),
  );

  assert.ok(waiting !== null && partial !== null);
  assert.equal(waiting.inFlight, true);
  assert.equal(partial.inFlight, true);
  assert.equal(partial.detail, "12 imported so far");
  assert.equal(waiting.detail, "Reading the history WhatsApp makes available.");
});

test("incremental counts render as the bot worker writes them", () => {
  // The bot-worker updates importedCount during the import; each poll must
  // render the growing number without special handling.
  const counts = [1, 7, 250];
  const details = counts.map((importedCount) => {
    const summary = summarizeHistoryImport(
      importState({ status: "running", importedCount }),
    );
    assert.ok(summary !== null);
    return summary.detail;
  });

  assert.deepEqual(details, [
    "1 imported so far",
    "7 imported so far",
    "250 imported so far",
  ]);
});

test("completed import distinguishes zero, one, and many messages", () => {
  const none = summarizeHistoryImport(importState({ status: "done", importedCount: 0 }));
  const one = summarizeHistoryImport(importState({ status: "done", importedCount: 1 }));
  const many = summarizeHistoryImport(importState({ status: "done", importedCount: 42 }));

  assert.ok(none !== null && one !== null && many !== null);
  // Neutral copy: 0 inserted can also mean "already imported" or "skipped".
  assert.equal(none.message, "No new older messages were imported.");
  assert.equal(one.message, "Imported 1 old message");
  assert.equal(many.message, "Imported 42 old messages");
  for (const summary of [none, one, many]) {
    assert.equal(summary.inFlight, false);
    assert.equal(summary.showRetry, false);
    assert.equal(summary.detail, null);
    assert.equal(summary.hint, null);
  }
});

test("failed import shows the safe error text and offers a retry", () => {
  const withError = summarizeHistoryImport(
    importState({ status: "failed", error: "history_unavailable" }),
  );
  const withoutError = summarizeHistoryImport(
    importState({ status: "failed", error: null }),
  );

  assert.ok(withError !== null && withoutError !== null);
  assert.equal(withError.inFlight, false);
  assert.equal(withError.showRetry, true);
  assert.equal(withError.message, "History import failed");
  assert.equal(
    withError.detail,
    "WhatsApp could not provide history for this chat.",
  );
  assert.equal(withoutError.detail, "The import did not finish.");

  const noAnchor = summarizeHistoryImport(
    importState({ status: "failed", error: "history_no_anchor" }),
  );
  assert.ok(noAnchor !== null);
  assert.match(noAnchor.detail ?? "", /no captured messages/i);
});
