export function buildOneTimeCommandScript(command: string) {
  const escapedCommand = command.replace(/'/g, `'"'"'`);
  return [
    `( eval '${escapedCommand}' )`,
    '__stacks_status=$?',
    `printf '\\r\\n\\r\\npress <ENTER> to return'`,
    'IFS= read -r __stacks_return',
    'exit "$__stacks_status"',
  ].join('\n');
}
