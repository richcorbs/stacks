import type React from 'react';
import type { Project, ToastState } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import type { PaletteItem } from './CommandPalette';
import type { CardPaletteRegistration } from '../commandPaletteCards';

export type MainLayoutProps = {
  projects: Project[];
  projectsHydrated: boolean;
  appSettings: ResolvedAppSettings;
  setKanbanProjectId: (projectId: string | null) => void;
  setKanbanDoneCollapsed: (collapsed: boolean) => void;
  openProjectDialog: () => void;
  cleanupCard: (card: import('../kanban/types').KanbanCard) => Promise<boolean>;
  startWork: (cardId: string) => Promise<boolean>;
  onPaletteCardsChange: (registration: CardPaletteRegistration | null) => void;
};

export type OverlayLayoutProps = {
  appSettings: ResolvedAppSettings;
  setAppSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>;
  commandPaletteOpen: boolean;
  commandPaletteItems: PaletteItem[];
  commandPaletteCardItems: PaletteItem[];
  settingsOpen: boolean;
  oneTimeCommandOpen: boolean;
  oneTimeCommandCwd: string | null;
  dialog: import('../types').DialogState | null;
  confirmDeleteProject: Project | null;
  confirmQuitOpen: boolean;
  toast: ToastState | null;
  setDialog: React.Dispatch<React.SetStateAction<import('../types').DialogState | null>>;
  closeCommandPalette: () => void;
  closeSettings: () => void;
  closeDialog: () => void;
  submitDialog: () => Promise<void>;
  closeOneTimeCommand: () => void;
  runOneTimeCommand: (command: string) => void;
  cancelDeleteProject: () => void;
  deleteProject: () => void;
  cancelQuit: () => void;
  quit: () => void;
};
