import TestRenderer, { act } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { DiffReviewModel } from '../diffReview/types';
import { CardDiffView } from './kanban/CardDiffView';
import { CardDetailTabs } from './kanban/CardDetailChrome';
import { DirectProjectWork } from './DirectProjectWork';
import { KanbanCardDetail } from './kanban/KanbanCardDetail';
import { sendTextToPiEditor } from '../pi/editorTextEvent';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('../pi/editorTextEvent', () => ({ sendTextToPiEditor: vi.fn().mockResolvedValue(true) }));
vi.mock('./DiffTab', () => ({ DiffTab: () => null }));
vi.mock('./DiffOverlay', () => ({ DiffOverlay: ({ onClose, onSubmit }: { onClose: () => void; onSubmit: () => void }) => <><button onClick={onClose}>Close diff</button><button onClick={onSubmit}>Submit review</button></> }));
vi.mock('./PiGuiView', () => ({ PiGuiView: () => null }));
vi.mock('./TerminalView', () => ({ TerminalView: () => null }));
vi.mock('./WorkspaceShellView', () => ({ WorkspaceShellView: () => null }));
vi.mock('./ProjectNotesView', () => ({ ProjectNotesView: () => null }));
vi.mock('./kanban/CardChatView', () => ({ CardChatView: () => null }));
vi.mock('./kanban/CardTerminalView', () => ({ CardTerminalView: () => null }));
vi.mock('./kanban/CardOverview', () => ({ CardOverview: () => null }));
vi.mock('./kanban/CardServiceTerminal', () => ({ CardServiceTerminal: () => null }));
vi.mock('../hooks/useManagedServices', () => ({ useManagedServices: () => ({ toggle: vi.fn() }) }));
vi.mock('../hooks/useDirectProjectShell', () => ({ useDirectProjectShell: () => ({ owner: { kind: 'project', projectId: 'p' }, workspaceId: 'w', shell: { focusedPaneId: null }, controller: {}, loading: false }) }));
vi.mock('../kanban/useCardTerminalWorkspace', () => ({ useCardTerminalWorkspace: () => ({ shell: { focusedPaneId: null }, controller: {} }) }));

function draft(review: DiffReviewModel) {
  act(() => {
    review.setOpenDiff({ path: 'src/a.ts', patch: '' });
    review.setOverallComment('overall');
    review.addComment({ filePath: 'src/a.ts', side: 'file', line: null });
    review.addComment({ filePath: 'src/a.ts', side: 'new', line: 1 });
    review.toggleReviewed('src/a.ts');
  });
}
function expectEmpty(review: DiffReviewModel) {
  expect(review.openDiff).toBeNull();
  expect(review.overallComment).toBe('');
  expect(review.comments).toEqual([]);
  expect(review.reviewedFiles.size).toBe(0);
}
function click(renderer: TestRenderer.ReactTestRenderer, label: string) {
  act(() => renderer.root.findAllByType('button').find((button) => button.props.children === label)!.props.onClick());
}

// Capture the live hook model at the component boundary, without replacing its reset behavior.
let review: DiffReviewModel;
vi.mock('../diffReview/useDiffReview', async (importOriginal) => {
  const original = await importOriginal<typeof import('../diffReview/useDiffReview')>();
  return { useDiffReview: (key: string) => { review = original.useDiffReview(key); return review; } };
});

const project = { id: 'p', name: 'Project', path: '/repo', workspaces: [] };
beforeAll(() => {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
});

describe('diff review Close', () => {
  it('cancels the card review and returns to chat', async () => {
    const card = { id: 'c', project_id: 'p', status: 'agent_working', capabilities: [], environment: { worktree_path: '/repo', target_branch: 'main' } };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<KanbanCardDetail card={card as never} cards={[]} cardServices={{} as never} projects={[project]} terminalFontSize={13} terminalFontFamily="monospace" terminalScrollback={1000} copyOnSelect={false} initialView="diff" gitChangeSummary={null} detailLoadError={null} detailRefreshError={null} requireActionPreflight={false} hasOlderEvents={false} onLoadOlderEvents={async () => {}} onRecheckEnvironment={async () => ({} as never)} onClose={() => {}} onUpdate={async () => card as never} onAction={async () => {}} onStopRefinement={async () => {}} onOpenChat={async () => {}} onStartWork={async () => true} onCleanup={async () => {}} onDelete={async () => {}} onReload={async () => card as never} onRetryRefresh={async () => {}} onCardUpdated={() => {}} onNavigate={() => {}} onToggleServer={() => {}} />); });
    draft(review);
    expect(renderer.root.findByType(CardDiffView).props.active).toBe(true);
    click(renderer, 'Close diff');
    expectEmpty(review);
    expect(renderer.root.findByType(CardDiffView).props.active).toBe(false);
    expect(renderer.root.findByType(CardDetailTabs).props.activeView).toBe('chat');
    act(() => renderer.root.findByType(CardDetailTabs).props.onRequestView('diff'));
    expect(renderer.root.findByType(CardDiffView).props.active).toBe(true);
    expectEmpty(review);
    draft(review);
    await act(async () => { renderer.root.findAllByType('button').find((button) => button.props.children === 'Submit review')!.props.onClick(); await Promise.resolve(); });
    expect(sendTextToPiEditor).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('overall'));
    expect(renderer.root.findByType(CardDetailTabs).props.activeView).toBe('chat');
    expectEmpty(review);
    act(() => renderer.unmount());
  });

  it('cancels the direct project review and returns to Agent; Submit still sends feedback', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<DirectProjectWork project={project} terminalFontSize={13} terminalFontFamily="monospace" terminalScrollback={1000} copyOnSelect={false} initialView="diff" onClose={() => {}} />); });
    draft(review);
    click(renderer, 'Close diff');
    expectEmpty(review);
    expect(renderer.root.findByProps({ className: 'cardChatView cardView active' })).toBeTruthy();
    click(renderer, 'Diff');
    expectEmpty(review);
    draft(review);
    vi.mocked(sendTextToPiEditor).mockClear();
    await act(async () => { renderer.root.findAllByType('button').find((button) => button.props.children === 'Submit review')!.props.onClick(); await Promise.resolve(); });
    expect(sendTextToPiEditor).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('overall'));
    expect(renderer.root.findByProps({ className: 'cardChatView cardView active' })).toBeTruthy();
    expectEmpty(review);
    act(() => renderer.unmount());
  });
});
