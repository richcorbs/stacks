import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { DialogState, Project } from '../types';
import type { ResolvedAppSettings } from '../settingsModel';
import { DEFAULT_APP_SETTINGS } from '../settingsModel';
import {
  clampUiFontSize,
  clampTerminalFontSize,
  clampTerminalScrollback,
  DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR,
  DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR,
  normalizeColor,
} from '../settings';
import {
  ConfirmationSettingsSection,
  EditorSettingsSection,
  InterfaceSettingsSection,
  TerminalSettingsSection,
} from './SettingsSections';
import { NotificationsSettingsSection } from './NotificationsSettingsSection';
import { DialogFields } from './DialogFields';

export type GlobalSettingsSection = 'interface' | 'terminal' | 'confirmations' | 'notifications' | 'editor' | 'superthread';
export type SettingsPageId = `global:${GlobalSettingsSection}` | `project:${string}`;

const GLOBAL_SECTIONS: Array<{ id: GlobalSettingsSection; label: string }> = [
  { id: 'interface', label: 'Interface' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'confirmations', label: 'Confirmations' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'editor', label: 'Editor' },
  { id: 'superthread', label: 'Superthread' },
];

const SECTION_FIELDS: Record<GlobalSettingsSection, Array<keyof ResolvedAppSettings>> = {
  interface: ['ui_font_size'],
  terminal: ['terminal_font_size', 'terminal_font_family', 'terminal_scrollback', 'copy_on_select', 'focused_terminal_border_color', 'maximized_terminal_border_color'],
  confirmations: ['confirm_close', 'confirm_delete'],
  notifications: ['activity_notifications'],
  editor: ['editor_app'],
  superthread: ['superthread_enabled'],
};

function projectDraft(project: Project): DialogState {
  return {
    kind: 'editProject', projectId: project.id, name: project.name, path: project.path,
    kanbanSource: project.kanban_source ?? 'local', startWorkCommand: project.start_work_command,
    superthreadSpaces: project.superthread_spaces, superthreadWorkspaceSlug: project.superthread_workspace_slug,
    serverCommand: project.server_command, consoleCommand: project.console_command,
    deliveryWorkflow: project.delivery_workflow ?? 'local_merge', targetBranch: project.target_branch ?? 'main',
    supportsFeatureEnvironments: project.supports_feature_environments ?? false,
    githubMergeStrategy: project.github_merge_strategy ?? 'merge', requirePassingCi: project.require_passing_ci ?? true,
    requireApproval: project.require_approval ?? false, releasesEnabled: project.releases_enabled ?? false,
    releaseConfigPath: project.release_config_path ?? '.stacks/release.json',
  };
}

function normalizeGlobal(draft: ResolvedAppSettings): ResolvedAppSettings {
  return {
    ...draft,
    ui_font_size: clampUiFontSize(draft.ui_font_size),
    terminal_font_size: clampTerminalFontSize(draft.terminal_font_size),
    terminal_font_family: draft.terminal_font_family.trim() || DEFAULT_APP_SETTINGS.terminal_font_family,
    terminal_scrollback: clampTerminalScrollback(draft.terminal_scrollback),
    editor_app: draft.editor_app.trim() || DEFAULT_APP_SETTINGS.editor_app,
    focused_terminal_border_color: normalizeColor(draft.focused_terminal_border_color, DEFAULT_FOCUSED_TERMINAL_BORDER_COLOR),
    maximized_terminal_border_color: normalizeColor(draft.maximized_terminal_border_color, DEFAULT_MAXIMIZED_TERMINAL_BORDER_COLOR),
  };
}

function selectedValues(settings: ResolvedAppSettings, section: GlobalSettingsSection) {
  return SECTION_FIELDS[section].map((field) => settings[field]);
}

export function SettingsDialog({ settings, projects, initialPage, onPageChange, onSaveSettings, onSaveProject, onDeleteProject, onNotificationsUnavailable, onClose }: {
  settings: ResolvedAppSettings;
  projects: Project[];
  initialPage: SettingsPageId;
  onPageChange: (page: SettingsPageId) => void;
  onSaveSettings: (section: GlobalSettingsSection, patch: Partial<ResolvedAppSettings>) => Promise<void>;
  onSaveProject: (projectId: string, draft: DialogState, expectedRevision: number) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onNotificationsUnavailable: (message: string) => void;
  onClose: () => void;
}) {
  const validInitial = initialPage.startsWith('project:') && !projects.some((project) => `project:${project.id}` === initialPage)
    ? 'global:interface' as const : initialPage;
  const [activePage, setActivePage] = useState<SettingsPageId>(validInitial);
  const [projectsExpanded, setProjectsExpanded] = useState(validInitial.startsWith('project:'));
  const [globalDraft, setGlobalDraft] = useState(settings);
  const [globalBaseline, setGlobalBaseline] = useState(settings);
  const [projectPageDraft, setProjectPageDraft] = useState<DialogState | null>(null);
  const [projectBaseline, setProjectBaseline] = useState<DialogState | null>(null);
  const [projectRevision, setProjectRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ type: 'page'; page: SettingsPageId } | { type: 'close' } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const navRefs = useRef(new Map<SettingsPageId, HTMLButtonElement>());
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const section = activePage.startsWith('global:') ? activePage.slice(7) as GlobalSettingsSection : null;
  const projectId = activePage.startsWith('project:') ? activePage.slice(8) : null;
  const project = projectId ? projects.find((candidate) => candidate.id === projectId) ?? null : null;

  useEffect(() => {
    requestAnimationFrame(() => navRefs.current.get(activePage)?.focus());
  }, []); // Focus the remembered destination when the dialog opens.

  useEffect(() => {
    setPageError(null);
    setPending(null);
    if (activePage.startsWith('global:')) {
      setGlobalDraft(settings);
      setGlobalBaseline(settings);
      setProjectPageDraft(null);
      setProjectBaseline(null);
    } else {
      const selected = projects.find((candidate) => `project:${candidate.id}` === activePage);
      const draft = selected ? projectDraft(selected) : null;
      setProjectPageDraft(draft);
      setProjectBaseline(draft);
      setProjectRevision(selected?.config_revision ?? 0);
    }
  }, [activePage]);

  const dirty = useMemo(() => {
    if (section) return JSON.stringify(selectedValues(globalDraft, section)) !== JSON.stringify(selectedValues(globalBaseline, section));
    return JSON.stringify(projectPageDraft) !== JSON.stringify(projectBaseline);
  }, [section, globalDraft, globalBaseline, projectPageDraft, projectBaseline]);

  function activate(page: SettingsPageId) {
    setActivePage(page);
    onPageChange(page);
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  function requestPage(page: SettingsPageId) {
    if (page === activePage) return;
    if (dirty) setPending({ type: 'page', page });
    else activate(page);
  }

  function requestClose() {
    if (saving) return;
    if (dirty) setPending({ type: 'close' });
    else onClose();
  }

  function cancelPending() {
    setPending(null);
    requestAnimationFrame(() => navRefs.current.get(activePage)?.focus());
  }

  function finishPending() {
    const action = pending;
    setPending(null);
    if (action?.type === 'page') activate(action.page);
    else if (action?.type === 'close') onClose();
  }

  async function save(): Promise<boolean> {
    if (saving) return false;
    setSaving(true);
    setPageError(null);
    try {
      if (section) {
        const normalized = normalizeGlobal(globalDraft);
        const patch = Object.fromEntries(SECTION_FIELDS[section].map((field) => [field, normalized[field]])) as Partial<ResolvedAppSettings>;
        await onSaveSettings(section, patch);
        setGlobalDraft(normalized);
        setGlobalBaseline(normalized);
      } else if (project && projectPageDraft) {
        await onSaveProject(project.id, projectPageDraft, projectRevision);
        setProjectRevision((revision) => revision + 1);
        setProjectBaseline(projectPageDraft);
      }
      return true;
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function chooseEditorApp() {
    const selected = await open({ directory: true, multiple: false, title: 'Choose Editor App', defaultPath: '/Applications' }).catch(() => null);
    if (typeof selected === 'string') setGlobalDraft((current) => ({ ...current, editor_app: selected }));
  }

  function restoreDefaults() {
    if (!section) return;
    setGlobalDraft((current) => ({
      ...current,
      ...Object.fromEntries(SECTION_FIELDS[section].map((field) => [field, DEFAULT_APP_SETTINGS[field]])),
    }));
  }

  async function confirmDelete() {
    if (!project || saving) return;
    setSaving(true);
    setPageError(null);
    try {
      const oldIndex = projects.findIndex((candidate) => candidate.id === project.id);
      await onDeleteProject(project.id);
      const remaining = projects.filter((candidate) => candidate.id !== project.id);
      const adjacent = remaining[Math.min(oldIndex, remaining.length - 1)];
      activate(adjacent ? `project:${adjacent.id}` : 'global:interface');
      setDeleteConfirm(false);
    } catch (error) {
      setDeleteConfirm(false);
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const title = section ? GLOBAL_SECTIONS.find((item) => item.id === section)?.label : project?.name ?? 'Project';
  const setProjectDraft: React.Dispatch<React.SetStateAction<DialogState | null>> = (next) => {
    setProjectPageDraft((current) => typeof next === 'function' ? next(current) : next);
  };

  return (
    <div className="modalBackdrop" onMouseDown={requestClose}>
      <div className="modal settingsModal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); if (pending) cancelPending(); else if (deleteConfirm) setDeleteConfirm(false); else requestClose(); }
      }}>
        <header className="settingsHeader"><h2 id="settings-title">Settings</h2><button type="button" aria-label="Close Settings" onClick={requestClose}>×</button></header>
        <div className="settingsWorkspace">
          <nav className="settingsNavigation" aria-label="Settings sections">
            {GLOBAL_SECTIONS.map((item) => {
              const id: SettingsPageId = `global:${item.id}`;
              return <button key={id} ref={(node) => { if (node) navRefs.current.set(id, node); else navRefs.current.delete(id); }} type="button" aria-current={activePage === id ? 'page' : undefined} onClick={() => requestPage(id)}>{item.label}</button>;
            })}
            <button type="button" className="settingsProjectsDisclosure" aria-expanded={projectsExpanded} aria-controls="settings-project-list" onClick={() => setProjectsExpanded((value) => !value)}>Projects<span className="settingsDisclosureChevron" aria-hidden="true" /></button>
            <div id="settings-project-list" className="settingsProjectList" hidden={!projectsExpanded}>
              {projects.map((item) => {
                const id: SettingsPageId = `project:${item.id}`;
                return <button key={id} ref={(node) => { if (node) navRefs.current.set(id, node); else navRefs.current.delete(id); }} type="button" aria-current={activePage === id ? 'page' : undefined} onClick={() => requestPage(id)}>{item.name}</button>;
              })}
              {!projects.length && <span>No projects configured</span>}
            </div>
          </nav>
          <main className="settingsContent" aria-labelledby="settings-page-heading">
            <h2 id="settings-page-heading" ref={headingRef} tabIndex={-1}>{title}</h2>
            <fieldset disabled={saving} className="settingsPageFields">
              {section === 'interface' && <InterfaceSettingsSection draft={globalDraft} firstInputRef={firstInputRef} update={(patch) => setGlobalDraft((current) => ({ ...current, ...patch }))} />}
              {section === 'terminal' && <TerminalSettingsSection draft={globalDraft} update={(patch) => setGlobalDraft((current) => ({ ...current, ...patch }))} />}
              {section === 'confirmations' && <ConfirmationSettingsSection draft={globalDraft} update={(patch) => setGlobalDraft((current) => ({ ...current, ...patch }))} />}
              {section === 'notifications' && <NotificationsSettingsSection draft={globalDraft} update={(patch) => setGlobalDraft((current) => ({ ...current, ...patch }))} onUnavailable={onNotificationsUnavailable} />}
              {section === 'editor' && <EditorSettingsSection draft={globalDraft} update={(patch) => setGlobalDraft((current) => ({ ...current, ...patch }))} chooseEditorApp={chooseEditorApp} />}
              {section === 'superthread' && <section className="settingsSection"><h3>Superthread</h3><label className="checkboxLabel"><input type="checkbox" checked={globalDraft.superthread_enabled} onChange={(event) => setGlobalDraft((current) => ({ ...current, superthread_enabled: event.target.checked }))} />Enable Superthread integration</label><div className="settingsHint">Spaces, URL slug, and start-work command are configured on the owning project.</div></section>}
              {projectPageDraft && <div className="dialogFields settingsProjectFields"><DialogFields dialog={projectPageDraft} setDialog={setProjectDraft} firstInputRef={firstInputRef} showHeading={false} /></div>}
            </fieldset>
            {pageError && <div className="dialogSubmitError" role="alert">{pageError}</div>}
            <div className="settingsPageActions">
              {project && <button type="button" className="dangerAction" disabled={saving} onClick={() => setDeleteConfirm(true)}>Delete Project</button>}
              <span />
              {section && <button type="button" disabled={saving} onClick={restoreDefaults}>Restore Defaults</button>}
              <button type="button" className="primaryAction" disabled={saving || !dirty} onClick={() => void save()}>Save</button>
            </div>
          </main>
        </div>
        {pending && <div className="settingsPromptBackdrop" onMouseDown={(event) => event.stopPropagation()}>
          <div className="settingsPrompt" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title">
            <h3 id="unsaved-title">Save changes?</h3><p>This page has unsaved changes.</p>
            {pageError && <div className="dialogSubmitError" role="alert">{pageError}</div>}
            <div className="modalActions"><button type="button" disabled={saving} onClick={cancelPending}>Cancel</button><button type="button" disabled={saving} onClick={finishPending}>Discard</button><button type="button" className="primaryAction" disabled={saving} autoFocus onClick={async () => { if (await save()) finishPending(); }}>Save</button></div>
          </div>
        </div>}
        {deleteConfirm && <div className="settingsPromptBackdrop" onMouseDown={() => setDeleteConfirm(false)}><form className="settingsPrompt" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void confirmDelete(); }}><h3 id="delete-project-title">Delete project?</h3><p>This will remove “{project?.name}” and permanently delete its completed card history. Active cards or remaining card environments block deletion.</p><div className="modalActions"><button type="button" disabled={saving} onClick={() => setDeleteConfirm(false)}>Cancel</button><button type="submit" className="dangerAction" disabled={saving} autoFocus>Delete</button></div></form></div>}
      </div>
    </div>
  );
}
