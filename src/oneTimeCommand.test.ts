import { describe, expect, it } from 'vitest';
import { buildOneTimeCommandScript } from './oneTimeCommand';

describe('buildOneTimeCommandScript', () => {
  it('safely quotes the command for evaluation in a subshell', () => {
    const script = buildOneTimeCommandScript(`printf "it's working"`);

    expect(script).toContain(`( eval 'printf "it'"'"'s working"' )`);
  });

  it('waits for Enter and exits with the command status', () => {
    const script = buildOneTimeCommandScript('exit 7');

    expect(script).toContain("( eval 'exit 7' )");
    expect(script).toContain('__stacks_status=$?');
    expect(script).toContain('press <ENTER> to return');
    expect(script).toContain('IFS= read -r __stacks_return');
    expect(script).toContain('exit "$__stacks_status"');
  });
});
