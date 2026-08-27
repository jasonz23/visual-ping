/** The password grammar and helpers for scanning arbitrary text for it. */

/** `VISUALPING{` + 16 hex digits + `}`. */
export const PASSWORD_PATTERN = /VISUALPING\{[0-9a-fA-F]{16}\}/g;

/**
 * Published in the challenge instructions as a format example. It is explicitly
 * *not* one of the eight, so we filter it out everywhere rather than in one place.
 */
export const EXAMPLE_PASSWORD = 'VISUALPING{0000deadbeef0000}';

export interface RawMatch {
  password: string;
  index: number;
  context: string;
}

/** Find every password in `text`, with a short surrounding excerpt for auditing. */
export function findPasswords(text: string, contextChars = 60): RawMatch[] {
  const out: RawMatch[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PASSWORD_PATTERN)) {
    const password = match[0];
    const index = match.index ?? 0;
    if (isExample(password)) continue;
    const key = `${password}@${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      password,
      index,
      context: excerpt(text, index, password.length, contextChars),
    });
  }
  return out;
}

export function isExample(password: string): boolean {
  return password.toLowerCase() === EXAMPLE_PASSWORD.toLowerCase();
}

/** A single-line excerpt around a match, with whitespace collapsed. */
export function excerpt(text: string, index: number, length: number, pad: number): string {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}
