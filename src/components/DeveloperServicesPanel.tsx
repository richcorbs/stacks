import { useEffect, useState, type ReactNode } from 'react';
import { GithubActionsTab } from './GithubActionsTab';
import { GithubPullRequestsTab } from './GithubPullRequestsTab';
import { SuperthreadCardDialog } from './SuperthreadCardDialog';
import { SuperthreadProjectDialog } from './SuperthreadProjectDialog';
import { SuperthreadTab } from './SuperthreadTab';
import { useSuperthreadCache } from '../superthread/useSuperthreadCache';
import { useGithub } from '../github/useGithub';
import type { GithubMergeStrategy } from '../github/types';
import type { Project } from '../types';
import type { SuperthreadCard } from '../superthread/types';

type PanelTab = 'superthread' | 'pull-requests' | 'actions';

export function DeveloperServicesPanel({
  visible,
  pullRequestsRequestNonce,
  projects,
  spaces,
  workspaceSlug,
  activePath,
  githubPollSeconds,
  githubMergeStrategy,
  superthreadEnabled,
  onStartWork,
}: {
  visible: boolean;
  pullRequestsRequestNonce: number;
  projects: Project[];
  spaces: string;
  workspaceSlug: string;
  activePath: string | null;
  githubPollSeconds: number;
  githubMergeStrategy: GithubMergeStrategy;
  superthreadEnabled: boolean;
  onStartWork: (projectId: string, cardNumber: string, cardTitle: string) => Promise<boolean>;
}) {
  const superthread = useSuperthreadCache(workspaceSlug, spaces, superthreadEnabled);
  const github = useGithub(activePath, githubPollSeconds, visible, githubMergeStrategy);
  const [tab, setTab] = useState<PanelTab>(superthreadEnabled ? 'superthread' : 'pull-requests');
  const [pendingWorkCard, setPendingWorkCard] = useState<SuperthreadCard | null>(null);
  const selectedCardStatus = superthread.selectedCard
    ? superthread.boards
      .find((board) => board.id === superthread.selectedCard?.board_id)
      ?.lists.find((list) => list.id === superthread.selectedCard?.list_id)
      ?.behavior
    : undefined;

  useEffect(() => {
    if (!superthreadEnabled && tab === 'superthread') setTab('pull-requests');
  }, [superthreadEnabled, tab]);

  useEffect(() => {
    if (pullRequestsRequestNonce > 0) setTab('pull-requests');
  }, [pullRequestsRequestNonce]);

  function refresh() {
    if (tab === 'superthread') superthread.loadBoards(true).catch(console.error);
    else github.refresh().catch(console.error);
  }

  return (
    <aside className={`superthreadPanel${visible ? '' : ' superthreadPanelHidden'}`} aria-label="Developer services">
      <header className="superthreadHeader integrationHeader">
        <div className="integrationTabs" role="tablist" aria-label="Developer services">
          {superthreadEnabled && <Tab active={tab === 'superthread'} onClick={() => setTab('superthread')}>Superthread</Tab>}
          <Tab active={tab === 'pull-requests'} onClick={() => setTab('pull-requests')}>GitHub PRs</Tab>
          <Tab active={tab === 'actions'} onClick={() => setTab('actions')}>GitHub Actions</Tab>
        </div>
        <button
          type="button"
          title="Refresh selected service"
          aria-label="Refresh selected service"
          disabled={tab === 'superthread' ? superthread.loading : github.loading || !activePath}
          onClick={refresh}
        >
          ↻
        </button>
      </header>

      <div className="superthreadTree integrationContent">
        {tab === 'superthread' && <SuperthreadTab superthread={superthread} />}
        {tab === 'pull-requests' && (
          <GithubPullRequestsTab
            activePath={activePath}
            pullRequests={github.pullRequests}
            repository={github.pullRequestRepository}
            loading={github.loading}
            error={github.pullRequestError}
            mergingNumber={github.mergingNumber}
            onMerge={github.mergePullRequest}
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
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button className={`integrationTab${active ? ' active' : ''}`} role="tab" aria-selected={active} type="button" onClick={onClick}>{children}</button>;
}
