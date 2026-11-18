import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTerminalSession } from '../terminalSessionManager';
import { useTerminalSearch } from './useTerminalSearch';

vi.mock('../terminalSessionManager', () => ({
  getTerminalSession: vi.fn(() => null),
  focusTerminalSession: vi.fn(),
}));
vi.mock('../terminalSearch', () => ({ countSearchMatches: vi.fn(() => 0) }));

type Search = ReturnType<typeof useTerminalSearch>;
let search: Search;
function Harness({ nonce }: { nonce: number }) {
  search = useTerminalSearch('terminal', nonce);
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined;
async function update(nonce: number) {
  await act(async () => { renderer!.update(<Harness nonce={nonce} />); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useTerminalSearch result callback', () => {
  it('keeps one stable public callback and ignores results while the search box is closed', async () => {
    await act(async () => { renderer = TestRenderer.create(<Harness nonce={0} />); });
    const callback = search.onSearchResultsChange;
    act(() => callback({ resultIndex: 0, resultCount: 3 }));
    expect(search.searchResultText).toBe('');

    await update(1);
    expect(search.onSearchResultsChange).toBe(callback);
    expect(search.searchOpen).toBe(true);
    act(() => search.onSearchResultsChange({ resultIndex: 0, resultCount: 0 }));
    // Open but empty: still no result readout.
    expect(search.searchResultText).toBe('');
  });

  it('uses committed search text and ignores results after it is cleared', async () => {
    await act(async () => { renderer = TestRenderer.create(<Harness nonce={0} />); });
    await update(1);
    await act(async () => { search.setSearchTerm('needle'); });
    act(() => search.onSearchResultsChange({ resultIndex: 0, resultCount: 3 }));
    expect(search.searchResultText).toBe('1/3');

    await act(async () => { search.setSearchTerm(''); });
    act(() => search.onSearchResultsChange({ resultIndex: 1, resultCount: 1 }));
    expect(search.searchResultText).toBe('1/3');
  });

  it('closes search and clears decorations', async () => {
    const clearDecorations = vi.fn();
    vi.mocked(getTerminalSession).mockReturnValue({ search: { clearDecorations, findNext: vi.fn(), findPrevious: vi.fn() } } as never);
    await act(async () => { renderer = TestRenderer.create(<Harness nonce={0} />); });
    await update(1);
    await act(async () => { search.setSearchTerm('needle'); });
    await act(async () => search.onClose());
    expect(clearDecorations).toHaveBeenCalled();
    expect(search.searchOpen).toBe(false);
    expect(search.searchTerm).toBe('');
  });
});
