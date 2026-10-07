/**
 * Guard against publishing win probability or betting-like content
 * (src/data/publicData.ts: never publish win probability, odds, spreads or
 * totals, not even inside Korean sentences). The collector runs this on every
 * file before writing it; `verify:data` has its own independent check.
 */

/** Splits "homeWinProbAfter", "home_wp_post" or "win-probability" into lower-case words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Why an object key is not publishable, or null when it is fine. */
export function forbiddenKeyReason(key: string): string | null {
  const words = keyWords(key);
  const joined = words.join("");
  if (words.includes("wp") || words.includes("wpa")) return "win probability key";
  if (joined.includes("winprob")) return "win probability key";
  if (joined.startsWith("vegas")) return "betting key";
  for (const fragment of ["odds", "spread", "moneyline", "totalline"]) {
    if (joined.includes(fragment)) return "betting key";
  }
  return null;
}

/** Korean (and a few English) phrases that read as probability or odds. */
const FORBIDDEN_TEXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/확률/, "probability wording"],
  [/%p/, "percentage points"],
  [/\d\s*%/, "percentage"],
  [/배당/, "odds wording"],
  [/win prob/i, "probability wording"],
];

/** Why a string value is not publishable, or null when it is fine. */
export function forbiddenTextReason(text: string): string | null {
  for (const [pattern, reason] of FORBIDDEN_TEXT) if (pattern.test(text)) return reason;
  return null;
}

/** The first forbidden key or phrase anywhere in `value`, as "path: reason", else null. */
export function findForbiddenContent(value: unknown, path = "$"): string | null {
  if (typeof value === "string") {
    const reason = forbiddenTextReason(value);
    return reason ? `${path}: ${reason} in "${value}"` : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenContent(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const reason = forbiddenKeyReason(key);
      if (reason) return `${path}.${key}: ${reason}`;
      const found = findForbiddenContent(child, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

/** Throws before a file with forbidden content can be written. */
export function assertPublishable(label: string, value: unknown): void {
  const found = findForbiddenContent(value);
  if (found) throw new Error(`${label}: refusing to publish ${found}`);
}
