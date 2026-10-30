/**
 * Text truncation that never splits a surrogate pair (audit L4).
 *
 * Schema length caps (`z.string().max(n)`) count UTF-16 code units, so
 * truncation must respect the same budget — but a naive
 * `text.slice(0, n)` can cut an emoji (or any astral character) in
 * half and leave a lone surrogate. Lone surrogates are not valid
 * Unicode and can break downstream writes (e.g. the summaries.result
 * jsonb). This helper walks CODE POINTS (like `Array.from` /
 * `Intl.Segmenter`) and stops before the first code point that would
 * exceed the UTF-16 budget, so the result is always <= maxLength code
 * units AND contains only complete code points.
 */

/**
 * Truncates `text` to at most `maxLength` UTF-16 code units without
 * splitting a surrogate pair. Trailing whitespace is not touched.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let out = "";
  let units = 0;
  // for...of iterates by code point (astral characters stay whole).
  for (const codePoint of text) {
    const width = codePoint.length;
    if (units + width > maxLength) break;
    out += codePoint;
    units += width;
  }
  return out;
}
