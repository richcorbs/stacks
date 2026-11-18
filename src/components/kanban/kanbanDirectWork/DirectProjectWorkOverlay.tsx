import type { Project } from '../../../types';
import type { WorkNavigationRequest, WorkView } from '../../../directWork';
import { DirectProjectWork } from '../../DirectProjectWork';

/** Direct project work surface mounted over the board. */
export function DirectProjectWorkOverlay({ projectId, projects, initialView, navigationRequest, onClose, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: {
  projectId: string | null;
  projects: Project[];
  initialView: WorkView | undefined;
  navigationRequest: WorkNavigationRequest | null;
  onClose: () => void;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
}) {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return null;
  return <DirectProjectWork
    project={project}
    terminalFontSize={terminalFontSize}
    terminalFontFamily={terminalFontFamily}
    terminalScrollback={terminalScrollback}
    copyOnSelect={copyOnSelect}
    initialView={initialView}
    navigationRequest={navigationRequest}
    onClose={onClose}
  />;
}
