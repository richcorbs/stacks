import { describe, expect, it } from 'vitest';
import { processExitAttention } from './terminalPty';

describe('PTY exit attention', () => {
  const base = {
    terminalId: 'kanban-card:card-1:terminal:server',
    workspaceId: 'kanban-card:card-1',
    generation: 'generation-1',
    commandBacked: true,
    eligible: true,
  };

  it('emits routing and generation metadata for natural command-backed exits', () => {
    expect(processExitAttention(base)).toEqual({
      kind: 'process-exit', owner: { kind: 'card', cardId: 'card-1' },
      target: { view: 'server', terminalId: base.terminalId },
      lifecycleKey: `pty:${base.terminalId}:generation-1:exit`,
    });
  });

  it('does not notify for interactive shells or intentionally stopped generations', () => {
    expect(processExitAttention({ ...base, commandBacked: false })).toBeNull();
    expect(processExitAttention({ ...base, eligible: false })).toBeNull();
  });

  it('requires a supported card or Project Workspace owner', () => {
    expect(processExitAttention({ ...base, workspaceId: 'legacy-workspace' })).toBeNull();
  });
});
