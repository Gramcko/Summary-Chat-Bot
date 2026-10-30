import { describe, expect, it } from "vitest";
import { truncateText } from "../src/lib/text.js";

/**
 * Audit L4: truncation must cut on CODE POINTS — a naive UTF-16 slice
 * at a boundary emoji leaves a lone surrogate, which is not valid
 * Unicode and can break the summaries.result jsonb write.
 */

/** True when the text contains an unpaired high surrogate. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text);
}

describe("truncateText (code-point safe)", () => {
  it("returns the input untouched when it fits", () => {
    expect(truncateText("abc", 3)).toBe("abc");
    expect(truncateText("😀", 2)).toBe("😀");
  });

  it("truncates ASCII to the exact budget", () => {
    expect(truncateText("abcdef", 3)).toBe("abc");
  });

  it("never splits a surrogate pair at the boundary", () => {
    // "👍" costs 2 UTF-16 units; a budget of 3 cuts INSIDE the emoji.
    const out = truncateText("ab👍cd", 3);
    expect(out).toBe("ab");
    expect(out.length).toBeLessThanOrEqual(3);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("keeps whole astral characters that fit in the budget", () => {
    expect(truncateText("a👍b", 3)).toBe("a👍");
  });

  it("stays schema-safe at the 5000-char overview cap with emoji", () => {
    // Odd budget: the naive slice would end mid-pair.
    const out = truncateText("👍".repeat(3000), 4999);
    expect(out.length).toBeLessThanOrEqual(4999);
    expect(out.length % 2).toBe(0); // complete pairs only
    expect(hasLoneSurrogate(out)).toBe(false);
    // JSON round-trip: what the jsonb write requires.
    expect(JSON.parse(JSON.stringify(out))).toBe(out);
  });
});
