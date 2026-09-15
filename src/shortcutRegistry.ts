import type { ShortcutAction } from './shortcutTypes';

export type ShortcutDefinition = { action: ShortcutAction; title: string; hint: string; keywords: string; key: string; shift: boolean };

export const SHORTCUT_DEFINITIONS = {
  'switch-project': {
    action: 'switch-project', title: 'Switch Project', hint: '⇧⌘P', keywords: 'kanban board project select change', key: 'p', shift: true,
  },
} as const satisfies Partial<Record<ShortcutAction, ShortcutDefinition>>;

export function registeredShortcutAction(key: string, shift: boolean): ShortcutAction | null {
  const definition = Object.values(SHORTCUT_DEFINITIONS).find((item) => item.key === key && item.shift === shift);
  return definition?.action ?? null;
}
