import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from './types';
import { attachTerminalPtyListeners, spawnTerminalPty } from './terminalPty';
const { listeners, invoke, output } = vi.hoisted(() => ({ listeners: new Map<string, (e: any) => void>(), invoke: vi.fn(), output: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (name: string, callback: (e: any) => void) => { listeners.set(name, callback); return Promise.resolve(() => listeners.delete(name)); } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./terminalOutput', () => ({ enqueueTerminalOutput: output }));
vi.mock('./terminalSessionManager', () => ({ focusTerminalSession: vi.fn() }));
beforeEach(() => { listeners.clear(); invoke.mockReset(); output.mockClear(); vi.stubGlobal('document', { fonts: { ready: Promise.resolve() } }); });
afterEach(() => vi.unstubAllGlobals());
function session() { return { starting: true, running: false, decoder: new TextDecoder(), fit: { fit() {} }, term: { cols: 80, rows: 24 } } as unknown as TerminalSession; }
async function attach(s: TerminalSession) { await attachTerminalPtyListeners({ session: s, terminalId: 'release:test', workspaceId: 'release-workspace:p', generation: 'new', commandBacked: true }); }
function exit(generation: string, status: number | null) { listeners.get('pty-exit')!({ payload: { terminal_id: 'release:test', generation, status } }); }
describe('PTY terminal release lifecycle', () => {
  it('ignores stale exit events and preserves the real exit status/output for matching generations', async () => {
    const s = session(); await attach(s);
    exit('old', 0); expect(s.exitStatus).toBeUndefined();
    exit('new', 7); expect(s.exitStatus).toBe(7); expect(s.running).toBe(false);
    expect(output.mock.calls.at(-1)?.[1]).toContain('[process exited: 7]');
  });
  it('does not resurrect a command that exits before the spawn response', async () => {
    const s = session(); await attach(s);
    invoke.mockImplementation(async () => { exit('new', 0); });
    await spawnTerminalPty({ session: s, term: s.term, fit: s.fit, terminalId: 'release:test', generation: 'new', cwd: '/repo', command: './release', active: false, managedService: true, isCancelled: () => false });
    expect(s.spawned).toBe(true); expect(s.running).toBe(false); expect(s.exitStatus).toBe(0);
  });
  it('does not turn an unavailable exit status into success', async () => {
    const s = session(); await attach(s); exit('new', null);
    expect(s.exitStatus).toBeNull(); expect(s.running).toBe(false);
  });
});
