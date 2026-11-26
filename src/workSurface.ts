import type { WorkView } from './directWork';
import type { ReactNode } from 'react';

/**
 * The visible tab strip entry. Both hosts derive these from their own tab
 * availability rules and hand the same shape to `WorkTabs`.
 */
export type WorkTab<T extends string = WorkView> = {
  view: T;
  label: string;
  /** Rendered but not selectable (e.g. Diff before an environment exists). */
  disabled?: boolean;
  disabledTitle?: string;
  /** Show the running dot and its accessible label on a Terminal tab. */
  running?: boolean;
  refreshDisabled?: boolean;
  refreshTitle?: string;
};

/** A section rendered in tab order. Host-owned views (Overview, Release) carry
 * their content here; shared views (Agent, Diff, Notes, Terminal) are filled in
 * by `WorkSurface` from its adapter. */
export type WorkSurfaceSection = {
  view: WorkView;
  content?: (active: boolean) => ReactNode;
};

export type WorkLeaveRules = {
  /** Card-only: unsaved edits/confirmation guard. */
  canLeave?: () => boolean | Promise<boolean>;
  /** Project-only: pending notes must be persisted before leaving. */
  flushNotes?: () => Promise<void>;
  onFlushError?: () => void;
  close: () => void;
};

/**
 * One leave path for both surfaces: run the host's guard, flush host-owned
 * pending writes, then close. Returns false when the surface must stay open.
 */
export async function requestWorkLeave(rules: WorkLeaveRules): Promise<boolean> {
  if (rules.canLeave && !await rules.canLeave()) return false;
  if (rules.flushNotes) {
    try {
      await rules.flushNotes();
    } catch {
      rules.onFlushError?.();
      return false;
    }
  }
  rules.close();
  return true;
}
