// npm run test:split-tree
// A real WorkspaceShellView/SplitView with real Pi panes and a mocked Pi session,
// so DOM structure, focus outcomes and session disposal are measured, not eyeballed.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { WorkspaceShellView } from '../src/components/WorkspaceShellView';
import { WorkspaceShellController } from '../src/workspaceShellController';
import type { Project, SplitNode, WorkspaceEntry } from '../src/types';
import { updateSession } from './pi-chat-scroll-session';
import '../src/styles.css';

mockWindows('main');
mockIPC(() => null);

type SideEffect = { disposed: string[]; persisted: number };

const sideEffects: SideEffect = { disposed: [], persisted: 0 };
let pendingId = 0;
const initialTree: SplitNode = {
  kind: 'split',
  direction: 'row',
  first: { kind: 'leaf', terminalId: 'pane:one', paneKind: 'pi' },
  second: {
    kind: 'split',
    direction: 'column',
    first: { kind: 'leaf', terminalId: 'pane:two', paneKind: 'pi' },
    second: { kind: 'leaf', terminalId: 'pane:three', paneKind: 'pi' },
  },
};

const controller = new WorkspaceShellController('contract', { tree: initialTree, focusedPaneId: 'pane:two' }, {
  createPaneId: () => `pane:new-${++pendingId}`,
  createPane: (id) => ({ id, workspaceId: 'contract', kind: 'pi' }),
  clearSession: () => {},
  disposeAndKill: (id) => sideEffects.disposed.push(id),
  write: () => {},
  scrollAfterFit: () => {},
  persist: () => { sideEffects.persisted += 1; },
});

const workspace = { id: 'contract', name: 'Split tree contract' } as WorkspaceEntry;
const project = { id: 'contract', name: 'Contract', path: '/tmp' } as Project;

function render() {
  root.render(<WorkspaceShellView
    controller={controller}
    workspace={workspace}
    project={project}
    visible
    terminalFontSize={13}
    terminalFontFamily="monospace"
    terminalScrollback={2000}
    copyOnSelect={false}
  />);
}

const root = createRoot(document.getElementById('fixture')!);
render();

const LAYOUT_CLASSES = /^(split|splitChild|split-row|split-column|cardTerminalPane|multiple|kanbanEmpty)$/;
function outline(element: Element): unknown {
  const paneId = (element as HTMLElement).dataset.piPaneId ?? (element as HTMLElement).dataset.terminalPaneId ?? null;
  if (paneId) {
    return {
      tag: element.tagName.toLowerCase(),
      paneId,
      active: element.classList.contains('active'),
      maximized: element.classList.contains('maximized'),
    };
  }
  const classes = [...element.classList].filter((name) => LAYOUT_CLASSES.test(name));
  const children = [...element.children].map(outline).filter(Boolean);
  if (!classes.length && !children.length) return null;
  return {
    tag: element.tagName.toLowerCase(),
    classes: classes.join(' '),
    flex: element instanceof HTMLElement && element.style.flex ? element.style.flex : null,
    children,
  };
}

function panes() {
  return [...document.querySelectorAll<HTMLElement>('[data-pi-pane-id]')].map((element) => ({
    id: element.dataset.piPaneId ?? null,
    active: element.classList.contains('active'),
    maximized: element.classList.contains('maximized'),
  }));
}

function snapshot() {
  const frozen = controller.getSnapshot();
  const activeElement = document.activeElement as HTMLElement | null;
  return {
    controller: {
      tree: frozen.tree,
      focusedPaneId: frozen.focusedPaneId,
      maximizedPaneId: frozen.maximizedPaneId,
      paneIds: frozen.paneIds,
      pendingClosePaneId: frozen.pendingClosePaneId,
    },
    dom: outline(document.getElementById('fixture')!),
    panes: panes(),
    focusedPaneInDom: activeElement?.closest<HTMLElement>('[data-pi-pane-id]')?.dataset.piPaneId ?? null,
    activeElement: activeElement ? `${activeElement.tagName.toLowerCase()}.${[...activeElement.classList].join('.')}` : null,
    composerFocused: activeElement?.tagName === 'TEXTAREA',
    disposed: [...sideEffects.disposed],
    persisted: sideEffects.persisted,
  };
}

// PiGuiView schedules composer focus on an animation frame, so a settled snapshot
// must wait for frames as well as timers or the focus measurement is a race.
const settle = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function run(step: () => void | Promise<void>) {
  await settle();
  flushSync(step);
  await settle();
  return snapshot();
}

Object.assign(window, {
  splitTreeTest: {
    snapshot,
    async focusComposer() {
      const focused = controller.getSnapshot().focusedPaneId!;
      const composer = document.querySelector<HTMLTextAreaElement>(`[data-pi-pane-id="${focused}"] textarea`)!;
      composer.focus();
      await settle();
      return snapshot();
    },
    async transcript() {
      const steps: Array<[string, () => void | Promise<void>]> = [
        ['initial', () => {}],
        ['split row', () => controller.split('row')],
        ['split column', () => controller.split('column')],
        ['resize root', () => controller.resize('', 0.7)],
        ['resize first (manual)', () => controller.resize('first', 0.35)],
        ['maximize', () => controller.toggleMaximize()],
        ['navigate forward while maximized', () => controller.navigatePane(1)],
        ['navigate back while maximized', () => controller.navigatePane(-1)],
        ['restore', () => controller.toggleMaximize()],
        ['focus second pane', () => controller.focus('pane:two')],
        ['request close', () => controller.requestClose()],
        ['cancel close', () => controller.cancelClose()],
        ['close focused pane', () => controller.close('pane:two')],
        ['close previous pane', () => controller.close(controller.getSnapshot().focusedPaneId!)],
        ['close remaining panes', () => {
          while (controller.getSnapshot().paneIds.length > 0) {
            controller.close(controller.getSnapshot().focusedPaneId!);
          }
        }],
      ];
      const transcript: Array<{ step: string; snapshot: unknown }> = [];
      for (const [step, action] of steps) transcript.push({ step, snapshot: await run(action) });
      return transcript;
    },
    async composerFocusAcrossSplit() {
      const results: unknown[] = [];
      results.push({ step: 'focused composer before split', snapshot: await this.focusComposer() });
      results.push({ step: 'split with composer focused', snapshot: await run(() => controller.split('row')) });
      results.push({ step: 'focus new composer', snapshot: await this.focusComposer() });
      results.push({ step: 'incoming message', snapshot: await run(() => updateSession({ messages: [{ role: 'user', content: 'Incoming message', timestamp: 1 }] })) });
      results.push({ step: 'stream update', snapshot: await run(() => updateSession({ isStreaming: true, streamingText: 'Streaming reply' })) });
      results.push({ step: 'stream complete', snapshot: await run(() => updateSession({ isStreaming: false, streamingText: '' })) });
      return results;
    },
  },
});
