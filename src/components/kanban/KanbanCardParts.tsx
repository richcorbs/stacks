import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Project } from '../../types';
import { projectColorAttribute } from '../../projectColor';
import type { CardPullRequestIndicator, KanbanCardSummary, KanbanStatus } from '../../kanban/types';
import type { CardRepositoryStatus } from '../../kanban/useCardRepositoryStatus';
import type { CardServices } from '../../kanban/useCardServices';
import { deliveryStep, type PrCheck } from '../../kanban/deliveryStep';
import { owningProject } from '../../kanban/projectScope';
import { pullRequestPresentation } from '../../kanban/pullRequestPresentation';
import { hasGitChanges } from '../../kanban/useCardRepositoryStatus';
import { ManagedServiceControl } from '../ManagedServiceControl';
import { AsyncButtonLabel } from '../AsyncButtonLabel';
import { GithubStatusIcon } from '../GithubStatusIcon';
import { CardHierarchyBadges } from './CardHierarchyBadges';

import type { BoardPrMergeProps } from '../../kanban/useBoardPrMerge';

type DoneLaneMenuProps = {
  cardsCount: number;
  collapsed: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  cleaningMerged: boolean;
  setOpen: Dispatch<SetStateAction<KanbanStatus | null>>;
  onToggle: () => void;
  onCleanupMerged: () => void;
};

type DoneLaneMenuDismissEvent = Pick<Event, 'type' | 'target'> & { key?: string };
type DoneLaneMenuWrapper = Pick<HTMLElement, 'contains'>;

export function shouldDismissDoneLaneMenu(wrapper: DoneLaneMenuWrapper | null, event: DoneLaneMenuDismissEvent) {
  if (event.type === 'keydown') return event.key === 'Escape';
  return event.type === 'pointerdown' && wrapper !== null && event.target !== null && !wrapper.contains(event.target as Node);
}

export function KanbanPullRequestBadge({ pullRequest, check }: { pullRequest: CardPullRequestIndicator; check?: PrCheck }) {
  if (pullRequest.state !== 'open') return null;
  const presentation = pullRequestPresentation(pullRequest);
  if (!presentation.indicatorStatus) return null;
  // The timestamp is an in-session successful GitHub read, not the card's edit time.
  // Without one, the persisted PR result is useful but its age is unknown.
  const age = check?.checkedAt == null
    ? 'last-known result; not checked this session'
    : `last checked ${Math.max(0, Math.floor((Date.now() - check.checkedAt) / 60_000))}m ago`;
  const freshness = [age, ...(check?.refreshing ? ['updating PR status'] : []), ...(check?.failed ? ['GitHub refresh failed; retrying'] : [])].join('; ');
  const result = pullRequest.ci_status === 'success' ? 'CI passed'
    : pullRequest.ci_status === 'failure' ? 'CI failed'
      : pullRequest.ci_status === 'pending' ? 'CI running'
        : pullRequest.ci_status === 'no_ci' ? 'no CI configured' : 'CI status unknown';
  const label = `Pull request #${pullRequest.number}, last-known ${presentation.status}, ${result}; ${freshness}; merge requires fresh preflight`;
  const unverified = check?.checkedAt == null || check.failed || check.refreshing || Date.now() - check.checkedAt >= 180_000;

  return (
    <span className={`kanbanPrBadge ${unverified ? 'openPending' : presentation.className}`} title={label}>
      PR #{pullRequest.number}
      <GithubStatusIcon status={presentation.indicatorStatus} context="CI" label={label} />
    </span>
  );
}

export function DoneLaneMenu({ cardsCount, collapsed, triggerRef, open, cleaningMerged, setOpen, onToggle, onCleanupMerged }: DoneLaneMenuProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;

    const dismissIfNeeded = (event: PointerEvent | KeyboardEvent) => {
      if (shouldDismissDoneLaneMenu(wrapperRef.current, event)) setOpen(null);
    };
    document.addEventListener('pointerdown', dismissIfNeeded);
    document.addEventListener('keydown', dismissIfNeeded);
    return () => {
      document.removeEventListener('pointerdown', dismissIfNeeded);
      document.removeEventListener('keydown', dismissIfNeeded);
    };
  }, [open, setOpen]);

  return (
    <span ref={wrapperRef} className="kanbanLaneMenu">
      <button
        ref={triggerRef}
        className="kanbanLaneMenuTrigger"
        type="button"
        aria-label="Done column actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={cleaningMerged}
        onClick={() => setOpen((current) => current === 'done' ? null : 'done')}
      >
        <span className="kanbanVerticalDots" aria-hidden="true"><i /><i /><i /></span>
      </button>
      {open && (
        <span className="kanbanLaneMenuPopover" role="menu">
          <button type="button" role="menuitem" onClick={onToggle}>{collapsed ? 'Expand column' : 'Collapse column'}</button>
          <button className="danger" type="button" role="menuitem" disabled={cardsCount === 0 || cleaningMerged} onClick={onCleanupMerged}>
            <AsyncButtonLabel idle="Clean up all" busy="Cleaning up…" isBusy={cleaningMerged} />
          </button>
        </span>
      )}
    </span>
  );
}

export function kanbanCardClassName(card: Pick<KanbanCardSummary, 'child_count'>, keyboardFocused = false) {
  return `kanbanCard${card.child_count > 0 ? ' kanbanParentCard' : ''}${keyboardFocused ? ' keyboardFocused' : ''}`;
}

export function KanbanServerControl({ services, onToggle }: { services: CardServices; onToggle: () => void }) {
  return <ManagedServiceControl services={services} mode="server" className="kanbanServerToggle" onToggle={onToggle} isolate />;
}

export function deliveryBadgeLabel(label: string) {
  const separator = ' · ';
  const separatorIndex = label.indexOf(separator);
  return separatorIndex === -1 ? label : label.slice(0, separatorIndex);
}

export function KanbanCardContents({
  card,
  projects,
  repositoryStatus,
  prCheck,
  serverServices,
  onNavigateParent,
  onToggleServer,
  listWarning,
  onMergePullRequest,
  mergingCardId,
}: BoardPrMergeProps & {
  card: KanbanCardSummary;
  projects: Project[];
  repositoryStatus: CardRepositoryStatus | undefined;
  prCheck?: PrCheck;
  serverServices?: CardServices;
  listWarning?: { tooltip: string; onOpen: () => void };
  onNavigateParent: (parentId: string) => void;
  onToggleServer: (cardId: string) => void;
}) {
  const hasHierarchy = Boolean(card.parent) || card.child_count > 0;
  const project = owningProject(card, projects);
  const projectBadge = <span data-project-color={projectColorAttribute(project)} className={`kanbanProjectBadge${project ? '' : ' invalid'}`}>{project?.name ?? 'Unknown project'}</span>;
  const delivery = deliveryStep(card, { projects, prChecks: prCheck ? { [card.id]: prCheck } : undefined });
  const statusBadge = <span className="kanbanCardStatusBadge" data-project-color={projectColorAttribute(project)} title={delivery.label} aria-label={delivery.label} role="status">{deliveryBadgeLabel(delivery.label)}</span>;
  const providerBoard = card.provider !== 'local' && card.board_title && card.board_title.trim().toLocaleLowerCase() !== 'dev - active'
    ? <span className="kanbanProviderBoardTitle">{card.board_title}</span> : null;
  const hasGitChangesBadge = repositoryStatus?.git?.status === 'ok' && hasGitChanges(repositoryStatus.git);
  const hasAttribution = card.provider !== 'local';
  const hasIndicators = Boolean(serverServices || repositoryStatus?.git?.status === 'error' || hasGitChangesBadge || (card.pull_request && (hasAttribution || card.pull_request.state === 'open')));

  return <>
    <span className="kanbanCardSource">
      <span className="kanbanCardSourceLeft">
        <span className="kanbanCardNumber">#{card.external_id}</span>
        {projectBadge}
        {statusBadge}
        {listWarning && <button className="kanbanEnvironmentWarning" type="button"
          title={listWarning.tooltip} aria-label={`Environment warning: ${listWarning.tooltip}`}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); listWarning.onOpen(); }}
        ><span aria-hidden="true">!</span></button>}
      </span>
      {hasHierarchy && <span className="kanbanHierarchyGroup">
        <CardHierarchyBadges card={card} onNavigateParent={onNavigateParent} />
      </span>}
    </span>
    <strong>{card.title}</strong>
    {(hasAttribution || hasIndicators) && <span className="kanbanCardMeta">
      {hasAttribution ? (
        <span className="kanbanCardAttribution">
          {providerBoard}
          <span title="Assigned in Superthread">{card.assignee_names.length > 0 ? card.assignee_names.join(', ') : 'Unassigned'}</span>
        </span>
      ) : <span className="kanbanCardLocalAttribution" aria-hidden="true" />}
      <span className="kanbanCardIndicators">
        {repositoryStatus?.git?.status === 'error' && <span className="kanbanGitBadge" title={repositoryStatus.git.message} aria-label="Git status unknown; check the worktree and refresh">Git ?</span>}
        {repositoryStatus?.git?.status === 'ok' && hasGitChanges(repositoryStatus.git) && (
          <span className="kanbanGitBadge" title={`${repositoryStatus.git.branch} working tree changes`}>
            {repositoryStatus.git.created > 0 && <span className="gitAdded">+{repositoryStatus.git.created}</span>}
            {repositoryStatus.git.changed > 0 && <span className="gitChanged">~{repositoryStatus.git.changed}</span>}
            {repositoryStatus.git.deleted > 0 && <span className="gitRemoved">-{repositoryStatus.git.deleted}</span>}
          </span>
        )}
        {card.pull_request && <KanbanPullRequestBadge pullRequest={card.pull_request} check={prCheck} />}
        {onMergePullRequest && (delivery.prMergeReady || mergingCardId === card.id) && <button
          className="kanbanServerToggle kanbanPrMerge" type="button"
          aria-label={`Merge PR #${card.pull_request?.number} for card #${card.external_id}`}
          title={mergingCardId === card.id ? 'Merging PR…' : `Merge PR #${card.pull_request?.number}`}
          disabled={mergingCardId === card.id} aria-busy={mergingCardId === card.id}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onPointerCancel={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onMergePullRequest(card, event.currentTarget); }}
        >{mergingCardId === card.id ? <span className="asyncButtonSpinner" aria-hidden="true" /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="6" cy="4" r="2" /><circle cx="6" cy="20" r="2" /><circle cx="18" cy="4" r="2" /><path d="M6 6v12M18 6c0 7-12 4-12 10" /></svg>}</button>}
        {serverServices && <KanbanServerControl services={serverServices} onToggle={() => onToggleServer(card.id)} />}
      </span>
    </span>}
  </>;
}
