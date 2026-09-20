import { invoke } from '@tauri-apps/api/core';
import { applicationEvents } from './applicationEvents';

export type ProjectNotesRecord = { notes: string; revision: number };
export type ProjectNotesStatus = 'loading' | 'saving' | 'saved' | 'error';
export type ProjectNotesSnapshot = {
  draft: string;
  status: ProjectNotesStatus;
  error: string | null;
  ready: boolean;
};

type NotesInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Listener = () => void;

export class ProjectNotesDraft {
  private revision = 0;
  private confirmed = '';
  private snapshot: ProjectNotesSnapshot = { draft: '', status: 'loading', error: null, ready: false };
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private blockedByFailure = false;
  private loadPromise: Promise<void>;
  private disposed = false;

  constructor(readonly projectId: string, private readonly call: NotesInvoke = invoke, private readonly debounceMs = 500) {
    this.loadPromise = this.load();
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  edit(draft: string) {
    if (!this.snapshot.ready) return;
    if (this.blockedByFailure) {
      this.update({ draft, status: 'error' });
      return;
    }
    this.update({ draft, status: draft === this.confirmed ? 'saved' : 'saving', error: null });
    this.schedule();
  }

  retry = () => {
    if (!this.snapshot.ready) {
      this.update({ status: 'loading', error: null });
      this.loadPromise = this.load();
      return this.loadPromise;
    }
    this.blockedByFailure = false;
    return this.saveLatest(true);
  };

  async flush() {
    await this.loadPromise;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.snapshot.ready || this.snapshot.status === 'error') throw new Error(this.snapshot.error || 'Could not save project notes');
    while (this.snapshot.draft !== this.confirmed) await this.saveLatest(false);
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  private async load() {
    try {
      const loaded = await this.call('load_project_notes', { projectId: this.projectId }) as ProjectNotesRecord;
      if (this.disposed) return;
      this.revision = loaded.revision;
      this.confirmed = loaded.notes;
      this.blockedByFailure = false;
      this.update({ draft: loaded.notes, status: 'saved', error: null, ready: true });
    } catch (error) {
      if (!this.disposed) this.update({ status: 'error', error: message(error), ready: false });
    }
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.saveLatest(false).catch(() => {}); }, this.debounceMs);
  }

  private saveLatest(explicitRetry: boolean): Promise<void> {
    if (this.inFlight) return this.inFlight.then(() => this.saveLatest(explicitRetry));
    if (!this.snapshot.ready) return this.loadPromise.then(() => this.saveLatest(explicitRetry));
    if (this.snapshot.status === 'error' && !explicitRetry) return Promise.reject(new Error(this.snapshot.error || 'Could not save project notes'));
    if (this.snapshot.draft === this.confirmed) { this.update({ status: 'saved', error: null }); return Promise.resolve(); }

    const notes = this.snapshot.draft;
    const expectedRevision = this.revision;
    this.update({ status: 'saving', error: null });
    const request = (this.call('save_project_notes', {
      projectId: this.projectId, notes, expectedRevision,
    }) as Promise<ProjectNotesRecord>).then((saved) => {
      if (this.disposed) return;
      this.revision = saved.revision;
      this.confirmed = notes;
      if (this.snapshot.draft === notes) this.update({ status: 'saved', error: null });
      else this.update({ status: 'saving', error: null });
    }).catch((error) => {
      this.blockedByFailure = true;
      if (!this.disposed) this.update({ status: 'error', error: message(error) });
      throw error;
    }).finally(() => { if (this.inFlight === request) this.inFlight = null; });
    this.inFlight = request;
    return request.then(() => {
      if (this.snapshot.draft !== this.confirmed) return this.saveLatest(false);
    });
  }

  private update(patch: Partial<ProjectNotesSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }

const pendingNotes = new Map<string, ProjectNotesDraft>();

export function registerProjectNotes(draft: ProjectNotesDraft) {
  pendingNotes.set(draft.projectId, draft);
  return () => { if (pendingNotes.get(draft.projectId) === draft) pendingNotes.delete(draft.projectId); };
}

export async function flushProjectNotes(projectId: string) {
  try {
    await pendingNotes.get(projectId)?.flush();
  } catch (error) {
    applicationEvents.publish('project-notes-save-failed', { projectId });
    throw error;
  }
}

export async function flushAllProjectNotes() {
  for (const draft of pendingNotes.values()) await flushProjectNotes(draft.projectId);
}
