import type { ShortcutAction } from './shortcutTypes';

export type ShortcutDefinition = {
  action: ShortcutAction;
  title: string;
  hint: string;
  keywords: string;
  key: string;
  shift: boolean;
};

export const SHORTCUT_DEFINITIONS = {
  'toggle-diff': {
    action: 'toggle-diff',
    title: 'Toggle Diff Panel',
    hint: '⌘G',
    keywords: 'diff changes review developer services panel sidebar',
    key: 'g',
    shift: false,
  },
  'toggle-github-pull-requests': {
    action: 'toggle-github-pull-requests',
    title: 'Toggle Pull Requests Panel',
    hint: '⇧⌘G',
    keywords: 'github pull requests prs developer services panel sidebar',
    key: 'g',
    shift: true,
  },
  'focus-next-unseen-workspace': {
    action: 'focus-next-unseen-workspace',
    title: 'Focus Next Workspace with Unseen Output',
    hint: '⇧⌘N',
    keywords: 'next yellow unseen output activity notification workspace',
    key: 'n',
    shift: true,
  },
} as const satisfies Partial<Record<ShortcutAction, ShortcutDefinition>>;

export function registeredShortcutAction(key: string, shift: boolean): ShortcutAction | null {
  const definition = Object.values(SHORTCUT_DEFINITIONS).find((item) => item.key === key && item.shift === shift);
  return definition?.action ?? null;
}
