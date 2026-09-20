import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCard } from './types';
import { canEditKanbanCard, hasDirtyCardDraft } from './cardEditing';
import { initialCardView, type CardView } from './cardView';
import { availableCardDetailTabs, CardRevisionTracker, resolveCardDetailNavigation, validCardDetailView, type CardDetailNavigationCommand, type CardDetailTabAvailability } from './cardDetailModel';

export function useCardDetailModel({ card, initialView, availability, onUpdate, confirmDiscard = () => window.confirm('Discard your unsaved card edits?') }: {
  card: KanbanCard;
  initialView?: CardView;
  availability: CardDetailTabAvailability;
  onUpdate: (title: string, content: string) => Promise<KanbanCard>;
  confirmDiscard?: () => boolean;
}) {
  const tabs = useMemo(() => availableCardDetailTabs(availability), [availability.chat, availability.console, availability.server, availability.workspace]);
  const [activeView, setActiveView] = useState<CardView>(() => validCardDetailView(card.hierarchy_finalized ? 'overview' : initialCardView(card.status, initialView), tabs));
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card.title);
  const [draftContent, setDraftContent] = useState(card.content);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const revisionTrackerRef = useRef(new CardRevisionTracker({ workflow: card.workflow_revision, environment: card.environment?.revision, layout: card.environment?.layout_revision }));
  const dirty = hasDirtyCardDraft(card, draftTitle, draftContent);
  const editable = canEditKanbanCard(card);

  const cancel = useCallback(() => {
    setDraftTitle(card.title); setDraftContent(card.content); setEditError(null); setEditing(false);
  }, [card.content, card.title]);
  const mayLeave = useCallback(() => !saving && (!editing || !dirty || confirmDiscard()), [confirmDiscard, dirty, editing, saving]);
  const command = useCallback((value: CardDetailNavigationCommand) => {
    const target = resolveCardDetailNavigation(activeView, tabs, value);
    if (!target || target === activeView) return Boolean(target);
    if (!mayLeave()) return false;
    if (editing) cancel();
    setActiveView(target);
    return true;
  }, [activeView, cancel, editing, mayLeave, tabs]);
  const begin = useCallback(() => {
    if (!editable || activeView !== 'overview') return false;
    setDraftTitle(card.title); setDraftContent(card.content); setEditError(null); setEditing(true); return true;
  }, [activeView, card.content, card.title, editable]);
  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true); setEditError(null);
    try {
      const updated = await onUpdate(draftTitle, draftContent);
      setDraftTitle(updated.title); setDraftContent(updated.content); setEditing(false);
      return updated;
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  }, [draftContent, draftTitle, onUpdate, saving]);

  useEffect(() => { revisionTrackerRef.current.observe({ workflow: card.workflow_revision, environment: card.environment?.revision, layout: card.environment?.layout_revision }); }, [card.environment?.layout_revision, card.environment?.revision, card.workflow_revision]);
  useEffect(() => {
    const valid = validCardDetailView(activeView, tabs);
    if (valid !== activeView && mayLeave()) { if (editing) cancel(); setActiveView(valid); }
  }, [activeView, cancel, editing, mayLeave, tabs]);

  return { activeView, setActiveView, tabs, command, mayLeave, editing, editable, dirty, draftTitle, setDraftTitle, draftContent, setDraftContent, editError, setEditError, saving, begin, cancel, save, revisionTrackerRef };
}
