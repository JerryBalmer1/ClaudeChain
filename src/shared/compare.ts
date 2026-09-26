/** Ordinal (UTF-16 code unit) comparison. Locale-independent, so ordering is identical on every machine. */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
