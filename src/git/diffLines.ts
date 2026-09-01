export type NumberedDiffLine = {
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export function numberDiffLines(patch: string): NumberedDiffLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;

  return patch.split('\n').map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, oldLine: null, newLine: null };
    }
    if (oldLine == null || newLine == null || text.startsWith('\\')) {
      return { text, oldLine: null, newLine: null };
    }
    if (text.startsWith('+') && !text.startsWith('+++')) {
      const line = { text, oldLine: null, newLine };
      newLine += 1;
      return line;
    }
    if (text.startsWith('-') && !text.startsWith('---')) {
      const line = { text, oldLine, newLine: null };
      oldLine += 1;
      return line;
    }
    const line = { text, oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}
