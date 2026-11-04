/**
 * Keyboard navigation for the WAI-ARIA tabs pattern (roving `tabIndex`).
 * Kept pure so `tests/tabs.test.ts` can cover the wrap-around without a DOM.
 */

/** Returns the index to focus for a navigation key, or `null` for other keys. */
export function nextTabIndex(
  current: number,
  key: string,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
