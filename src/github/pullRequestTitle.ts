export function pullRequestTitleParts(title: string): { prefix: string; suffix: string | null } {
  const match = title.match(/^(.*)(\bST-\d+\b.*)$/i);
  if (!match) return { prefix: title, suffix: null };
  let prefix = match[1].trimEnd();
  let suffix = match[2].trim();
  if (prefix.endsWith('(') || prefix.endsWith('[')) {
    suffix = `${prefix.slice(-1)}${suffix}`;
    prefix = prefix.slice(0, -1).trimEnd();
  }
  return { prefix, suffix };
}
