import type { Project } from '../types';
import { DirectWorkGitMetadata, type DirectWorkGitState } from './DirectWorkGitMetadata';

export const PROJECT_WORKSPACE_NAME = 'Project Workspace';
export const PROJECT_WORKSPACE_VIEWS_LABEL = 'Project Workspace views';
export const PROJECT_WORKSPACE_AGENT_LABEL = 'Project Workspace Agent';

export function ProjectWorkspaceHeader({ project, gitState, onClose }: {
  project: Project;
  gitState: DirectWorkGitState;
  onClose: () => void;
}) {
  return <header>
    <div className="kanbanDetailHeading">
      <div className="kanbanDetailHeaderMeta"><span>{PROJECT_WORKSPACE_NAME}</span><span title={project.path}>{project.path}</span></div>
      <h2>{project.name}</h2>
      <DirectWorkGitMetadata gitState={gitState} />
    </div>
    <button type="button" aria-label="Close Project Workspace" onClick={onClose}>×</button>
  </header>;
}
