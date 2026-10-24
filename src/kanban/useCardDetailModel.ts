import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfirmation } from '../components/ConfirmDialogs';
import type { KanbanCard } from './types';
import { canEditKanbanCard, hasDirtyCardDraft } from './cardEditing';
import { initialCardView, type CardView } from './cardView';
import { availableCardDetailTabs, displayedCardDetailTabs, CardRevisionTracker, resolveCardDetailNavigation, validCardDetailView, type CardDetailNavigationCommand, type CardDetailTabAvailability } from './cardDetailModel';

export function useCardDetailModel({ card, initialView, availability, onUpdate, confirmDiscard, onViewSelected }: {
  card: KanbanCard;
  initialView?: CardView;
  availability: CardDetailTabAvailability;
  onUpdate: (title: string, content: string) => Promise<KanbanCard>;
  confirmDiscard?: () => boolean | Promise<boolean>;
  onViewSelected?: (view: CardView) => void;
}) {
  const confirmation = useConfirmation(`${card.id}:${card.record_revision}`);
  const latest = useRef({ card, saving: false, draftTitle: card.title, draftContent: card.content });
  const tabs = useMemo(() => availableCardDetailTabs(availability), [availability.chat, availability.console, availability.server, availability.workspace]);
  const displayedTabs = useMemo(() => displayedCardDetailTabs(card.hierarchy_finalized, availability), [card.hierarchy_finalized, availability.workspace, availability.server, availability.console]);
  const [activeView, setActiveView] = useState<CardView>(() => validCardDetailView(card.hierarchy_finalized ? 'overview' : initialCardView(card.status, initialView), tabs));
  const navigation = useRef({ activeView, tabs });
  navigation.current = { activeView, tabs };
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card.title);
  const [draftContent, setDraftContent] = useState(card.content);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const revisionTrackerRef = useRef(new CardRevisionTracker({ workflow: card.workflow_revision, environment: card.environment?.revision, layout: card.environment?.layout_revision }));
  const dirty = hasDirtyCardDraft(card, draftTitle, draftContent);
  const editable = canEditKanbanCard(card);

  const cancel = useCallback(() => {
    setDraftTitle(card.title); setDraftContent(card.content); setEditError(null); setEditing(false);
  }, [card.content, card.title]);
  latest.current = { card, saving, draftTitle, draftContent };
  const mayLeave = useCallback((): boolean | Promise<boolean> => {
    if (savingRef.current) return false;
    if (!editing || !dirty) return true;
    const snapshot = latest.current;
    const result = confirmDiscard ? confirmDiscard() : confirmation.confirm('Discard your unsaved card edits?', '', 'Discard');
    const validate = (accepted: boolean) => {
      const current = latest.current;
      return accepted && !savingRef.current && snapshot.card.id === current.card.id && snapshot.card.record_revision === current.card.record_revision
        && snapshot.draftTitle === current.draftTitle && snapshot.draftContent === current.draftContent;
    };
    return typeof result === 'boolean' ? validate(result) : result.then(validate);
  }, [confirmDiscard, confirmation.confirm, dirty, editing]);
  const command = useCallback((value: CardDetailNavigationCommand) => {
    const target = resolveCardDetailNavigation(activeView, tabs, displayedTabs, value);
    if (!target) return false;
    if (target === activeView) {
      onViewSelected?.(target);
      return true;
    }
    const navigate = (accepted: boolean) => {
      if (!accepted || savingRef.current || navigation.current.activeView !== activeView || !navigation.current.tabs.includes(target)) return false;
      if (editing) cancel();
      setActiveView(target);
      onViewSelected?.(target);
      return true;
    };
    const result = mayLeave();
    return typeof result === 'boolean' ? navigate(result) : result.then(navigate);
  }, [activeView, cancel, displayedTabs, editing, mayLeave, onViewSelected, tabs]);
  const begin = useCallback(() => {
    if (!editable || activeView !== 'overview') return false;
    setDraftTitle(card.title); setDraftContent(card.content); setEditError(null); setEditing(true); return true;
  }, [activeView, card.content, card.title, editable]);
  const save = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true); setEditError(null);
    try {
      const updated = await onUpdate(draftTitle, draftContent);
      setDraftTitle(updated.title); setDraftContent(updated.content); setEditing(false);
      return updated;
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally { savingRef.current = false; setSaving(false); }
  }, [draftContent, draftTitle, onUpdate]);

  useEffect(() => { revisionTrackerRef.current.observe({ workflow: card.workflow_revision, environment: card.environment?.revision, layout: card.environment?.layout_revision }); }, [card.environment?.layout_revision, card.environment?.revision, card.workflow_revision]);
  useEffect(() => {
    const valid = validCardDetailView(activeView, tabs);
    let active = true;
    if (valid !== activeView) void Promise.resolve(mayLeave()).then((accepted) => { if (active && accepted) { if (editing) cancel(); setActiveView(valid); } });
    return () => { active = false; };
  }, [activeView, cancel, editing, mayLeave, tabs]);

  return { confirmationDialog: confirmation.dialog, activeView, setActiveView, tabs, command, mayLeave, editing, editable, dirty, draftTitle, setDraftTitle, draftContent, setDraftContent, editError, setEditError, saving, begin, cancel, save, revisionTrackerRef };
}
