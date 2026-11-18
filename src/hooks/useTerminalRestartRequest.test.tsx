import { StrictMode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalRestartRequest } from './useTerminalRestartRequest';

function Harness({ nonce, restart }: { nonce: number; restart: () => boolean }) {
  useTerminalRestartRequest(nonce, restart);
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined;
async function mount(nonce: number, restart: () => boolean, strict = false) {
  const tree = <Harness nonce={nonce} restart={restart} />;
  await act(async () => {
    renderer = TestRenderer.create(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}
async function update(nonce: number, restart: () => boolean, strict = false) {
  const tree = <Harness nonce={nonce} restart={restart} />;
  await act(async () => { renderer!.update(strict ? <StrictMode>{tree}</StrictMode> : tree); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('useTerminalRestartRequest', () => {
  it('restarts only for a new positive nonce', async () => {
    const restart = vi.fn(() => true);
    await mount(0, restart);
    expect(restart).not.toHaveBeenCalled();
    await update(1, restart);
    expect(restart).toHaveBeenCalledOnce();
    await update(1, restart);
    expect(restart).toHaveBeenCalledOnce();
    await update(2, restart);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('uses the latest callback without turning a callback identity change into a restart request', async () => {
    const first = vi.fn(() => true);
    await mount(0, first);
    await update(0, vi.fn(() => true));
    expect(first).not.toHaveBeenCalled();

    const current = vi.fn(() => true);
    await update(3, current);
    expect(first).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it('does not duplicate a request under StrictMode', async () => {
    const restart = vi.fn(() => true);
    await mount(0, restart, true);
    await update(1, restart, true);
    expect(restart).toHaveBeenCalledOnce();
  });
});
