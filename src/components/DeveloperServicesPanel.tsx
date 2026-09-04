import { useEffect, useState, type ReactNode } from 'react';
import { DiffTab } from './DiffTab';
import { GithubActionsTab } from './GithubActionsTab';
import { GithubPullRequestsTab } from './GithubPullRequestsTab';
import { ConfirmMergePullRequestDialog, ResumePrCleanupDialog } from './ConfirmDialogs';
import { SuperthreadCardDialog } from './SuperthreadCardDialog';
import { SuperthreadProjectDialog } from './SuperthreadProjectDialog';
import { SuperthreadTab } from './SuperthreadTab';
import { useSuperthreadCache } from '../superthread/useSuperthreadCache';
import { useGithub } from '../github/useGithub';
import { runPrMergeCleanupWorkflow } from '../github/mergeWorkflow';
import type { GithubMergeStrategy, GithubPullRequest } from '../github/types';
import type { PendingPrCleanup, Project } from '../types';
import type { DiffReviewModel } from '../diffReview/types';
import type { DeveloperServicesTab } from '../developerServices';
import type { SuperthreadCard } from '../superthread/types';
import { clearPendingPrCleanup, loadPendingPrCleanup, savePendingPrCleanup } from '../github/prCleanupPersistence';

export function DeveloperServicesPanel({
  visible,
  activeTab,
  onActiveTabChange,
  projects,
  spaces,
  workspaceSlug,
  activePath,
  diffPath,
  githubPollSeconds,
  githubMergeStrategy,
  superthreadEnabled,
  diffReview,
  onStartWork,
  onPrepareCleanup,
  onRunCleanup,
}: {
  visible: boolean;
  activeTab: DeveloperServicesTab;
  onActiveTabChange: (tab: DeveloperServicesTab) => void;
  projects: Project[];
  spaces: string;
  workspaceSlug: string;
  activePath: string | null;
  diffPath: string | null;
  githubPollSeconds: number;
  githubMergeStrategy: GithubMergeStrategy;
  superthreadEnabled: boolean;
  diffReview: DiffReviewModel;
  onStartWork: (projectId: string, cardNumber: string, cardTitle: string) => Promise<boolean>;
  onPrepareCleanup: (pullRequest: GithubPullRequest, repository: string) => Promise<{ operation: PendingPrCleanup; error?: never } | { operation: null; error: string }>;
  onRunCleanup: (operation: PendingPrCleanup) => Promise<boolean>;
}) {
  const superthread = useSuperthreadCache(workspaceSlug, spaces, superthreadEnabled);
  const github = useGithub(activePath, githubPollSeconds, visible, githubMergeStrategy);
  const tab = activeTab;
  const setTab = onActiveTabChange;
  const [pendingWorkCard, setPendingWorkCard] = useState<SuperthreadCard | null>(null);
  const [pendingMerge, setPendingMerge] = useState<{ pullRequest: GithubPullRequest; repository: string } | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [recoveryOperation, setRecoveryOperation] = useState<PendingPrCleanup | null>(null);
  const [diffRefreshNonce, setDiffRefreshNonce] = useState(0);
  const selectedCardStatus = superthread.selectedCard
    ? superthread.boards
      .find((board) => board.id === superthread.selectedCard?.board_id)
      ?.lists.find((list) => list.id === superthread.selectedCard?.list_id)
      ?.behavior
    : undefined;

  useEffect(() => {
    if (!superthreadEnabled && tab === 'superthread') setTab('pull-requests');
  }, [setTab, superthreadEnabled, tab]);

  useEffect(() => {
    loadPendingPrCleanup().then(setRecoveryOperation).catch(console.error);
  }, []);

  async function continueCleanup(operation: PendingPrCleanup) {
    let current = operation;
    if (current.stage === 'ready-to-merge') {
      const merged = await github.mergePullRequest(current.repository, current.pullRequestNumber);
      if (!merged) return false;
      current = await savePendingPrCleanup(current, 'merged');
    }
    return onRunCleanup(current);
  }

  function refresh() {
    if (tab === 'superthread') superthread.loadBoards(true).catch(console.error);
    else if (tab === 'diff') setDiffRefreshNonce((nonce) => nonce + 1);
    else github.refresh().catch(console.error);
  }

  return (
    <>
    <aside className={`superthreadPanel${visible ? '' : ' superthreadPanelHidden'}`} aria-label="Developer services">
      <header className="superthreadHeader integrationHeader">
        <div className="integrationTabs" role="tablist" aria-label="Developer services">
          {superthreadEnabled && <Tab active={tab === 'superthread'} onClick={() => setTab('superthread')}>ST</Tab>}
          <Tab active={tab === 'diff'} onClick={() => setTab('diff')}>DIFF</Tab>
          <Tab active={tab === 'pull-requests'} onClick={() => setTab('pull-requests')}>PRs</Tab>
          <Tab active={tab === 'actions'} onClick={() => setTab('actions')}>ACTIONS</Tab>
        </div>
        <button
          type="button"
          title="Refresh selected service"
          aria-label="Refresh selected service"
          disabled={tab === 'superthread' ? superthread.loading : tab === 'diff' ? !diffPath : github.loading || !activePath}
          onClick={refresh}
        >
          ↻
        </button>
      </header>

      <div className="superthreadTree integrationContent">
        {tab === 'superthread' && <SuperthreadTab superthread={superthread} />}
        {tab === 'diff' && <DiffTab activePath={diffPath} refreshNonce={diffRefreshNonce} review={diffReview} />}
        {tab === 'pull-requests' && (
          <GithubPullRequestsTab
            activePath={activePath}
            pullRequests={github.pullRequests}
            repository={github.pullRequestRepository}
            loading={github.loading}
            error={github.pullRequestError}
            mergingNumber={github.mergingNumber}
            onRequestMerge={(pullRequest, repository) => {
              setCleanupError(null);
              setPendingMerge({ pullRequest, repository });
            }}
          />
        )}
        {tab === 'actions' && (
          <GithubActionsTab
            activePath={activePath}
            actionRuns={github.actionRuns}
            loading={github.loading}
            error={github.actionRunsError}
          />
        )}
      </div>

      {tab === 'superthread' && superthread.selectedCard && (
        <SuperthreadCardDialog
          card={superthread.selectedCard}
          status={selectedCardStatus}
          loading={superthread.cardLoading}
          error={superthread.cardError}
          onRequestStartWork={(card) => {
            superthread.closeCard();
            setPendingWorkCard(card);
          }}
          onClose={superthread.closeCard}
        />
      )}

      {pendingWorkCard && (
        <SuperthreadProjectDialog
          card={pendingWorkCard}
          projects={projects}
          onCancel={() => setPendingWorkCard(null)}
          onStart={onStartWork}
        />
      )}
    </aside>
    {pendingMerge && (
      <ConfirmMergePullRequestDialog
        number={pendingMerge.pullRequest.number}
        pullRequestTitle={pendingMerge.pullRequest.title}
        cleanupError={cleanupError}
        onCancel={() => {
          setCleanupError(null);
          setPendingMerge(null);
        }}
        onConfirm={(cleanupAfter) => {
          const { repository, pullRequest } = pendingMerge;
          const run = async () => {
            if (!cleanupAfter) {
              setPendingMerge(null);
              await github.mergePullRequest(repository, pullRequest.number);
              return;
            }
            const prepared = await onPrepareCleanup(pullRequest, repository);
            if (!prepared.operation) {
              setCleanupError(prepared.error);
              return;
            }
            setPendingMerge(null);
            const result = await runPrMergeCleanupWorkflow(
              prepared.operation,
              () => github.mergePullRequest(repository, pullRequest.number),
              (operation) => savePendingPrCleanup(operation, 'merged'),
              onRunCleanup,
            );
            if (!result.merged) await clearPendingPrCleanup();
            else if (!result.cleanupCompleted) setRecoveryOperation(await loadPendingPrCleanup());
          };
          run().catch((error) => {
            console.error(error);
            window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Could not complete PR cleanup: ${String(error)}` } }));
          });
        }}
      />
    )}
    {recoveryOperation && !pendingMerge && (
      <ResumePrCleanupDialog
        operation={recoveryOperation}
        onCancel={() => {
          clearPendingPrCleanup().then(() => setRecoveryOperation(null)).catch(console.error);
        }}
        onResume={() => {
          const operation = recoveryOperation;
          setRecoveryOperation(null);
          continueCleanup(operation).then(async (completed) => {
            if (!completed) setRecoveryOperation(await loadPendingPrCleanup());
          }).catch(async (error) => {
            console.error(error);
            setRecoveryOperation(await loadPendingPrCleanup().catch(() => operation));
          });
        }}
      />
    )}
    </>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button className={`integrationTab${active ? ' active' : ''}`} role="tab" aria-selected={active} type="button" onClick={onClick}>{children}</button>;
}
