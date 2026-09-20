import { showAppToast } from '../applicationEvents';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { Project } from '../types';
import type { KanbanCardSummary } from './types';
import { handleEditableClipboardKeyDown } from './editableClipboard';
import { preselectedCardProject } from './projectScope';
import { applicationEvents } from '../applicationEvents';

export function useNewCardDialog({
  creationProjects,
  selectedProject,
  filterProjectId,
  create,
  openCard,
}: {
  creationProjects: Project[];
  selectedProject: Project | null;
  filterProjectId: string | null;
  create: (project: Project, title: string, content: string, parentId: string | null) => Promise<KanbanCardSummary>;
  openCard: (card: KanbanCardSummary) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const clipboardOperationRef = useRef(new WeakMap<HTMLInputElement | HTMLTextAreaElement, number>());

  function show(requestedProjectId?: string) {
    const requested = creationProjects.find((project) => project.id === requestedProjectId);
    setProjectId(requested?.id ?? preselectedCardProject(creationProjects, selectedProject)?.id ?? '');
    setError(null);
    setOpen(true);
  }

  useEffect(() => applicationEvents.subscribe('new-card', ({ projectId }) => show(projectId)), [creationProjects, selectedProject]);

  function invalidateClipboardOperation(control: HTMLInputElement | HTMLTextAreaElement) {
    clipboardOperationRef.current.set(control, (clipboardOperationRef.current.get(control) ?? 0) + 1);
  }

  function handleClipboard(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    setValue: (value: string) => void,
  ) {
    const control = event.currentTarget;
    const operation = (clipboardOperationRef.current.get(control) ?? 0) + 1;
    clipboardOperationRef.current.set(control, operation);
    void handleEditableClipboardKeyDown({
      event,
      isCurrent: () => clipboardOperationRef.current.get(control) === operation,
      readText,
      requestFrame: (callback) => requestAnimationFrame(callback),
      setValue,
      showError: (message) => showAppToast(message),
      writeText,
    });
  }

  async function submit(outcome: 'close' | 'continue' | 'open') {
    const destination = creationProjects.find((project) => project.id === projectId);
    if (creating || !destination || !title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const card = await create(destination, title, description, parentId || null);
      setTitle('');
      setDescription('');
      setParentId('');
      const filteredOut = Boolean(filterProjectId && filterProjectId !== destination.id);
      if (outcome === 'open') {
        setOpen(false);
        if (filteredOut) showAppToast(`Card added to ${destination.name}; it is hidden by the current filter`);
        await openCard(card);
      } else {
        showAppToast(filteredOut ? `Card added to ${destination.name}; it is hidden by the current filter` : `Card added to ${destination.name}`);
        if (outcome === 'close') setOpen(false);
        else requestAnimationFrame(() => titleRef.current?.focus());
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setCreating(false);
    }
  }

  return {
    open,
    setOpen,
    title,
    setTitle,
    description,
    setDescription,
    projectId,
    setProjectId,
    parentId,
    setParentId,
    error,
    creating,
    titleRef,
    show,
    submit,
    invalidateClipboardOperation,
    handleClipboard,
  };
}
