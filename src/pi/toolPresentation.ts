export function piToolSummary(name: string, args: unknown, running: boolean) {
  const normalizedName = name.toLowerCase();
  const values = objectValue(args);
  if (normalizedName === 'edit') {
    const path = stringValue(values.path) || stringValue(values.file_path) || 'file';
    return { label: `editing ${fileName(path)}`, title: `editing ${path}` };
  }
  if (normalizedName === 'bash') {
    const command = stringValue(values.command) || 'command';
    const preview = command.split('\n')[0].trim();
    const commandLabel = preview.length > 140 ? `${preview.slice(0, 137)}…` : preview;
    return { label: `${running ? 'running' : 'ran'}: ${commandLabel}`, title: command };
  }
  return { label: normalizedName, title: normalizedName };
}

export function piEditDiff(details: unknown, args: unknown) {
  const resultDetails = objectValue(details);
  if (typeof resultDetails.diff === 'string' && resultDetails.diff) return resultDetails.diff;
  const values = objectValue(args);
  const edits = Array.isArray(values.edits) ? values.edits : [];
  const lines: string[] = [];
  for (const candidate of edits) {
    const edit = objectValue(candidate);
    if (typeof edit.oldText === 'string') lines.push(...edit.oldText.split('\n').map((line) => `-${line}`));
    if (typeof edit.newText === 'string') lines.push(...edit.newText.split('\n').map((line) => `+${line}`));
  }
  return lines.join('\n');
}

export function piDiffLineKind(line: string): 'added' | 'removed' | 'context' {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'removed';
  return 'context';
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function fileName(path: string) {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).pop() || path;
}
