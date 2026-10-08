import type { Project } from './types';

export const PROJECT_COLORS = ['blue', 'slate', 'teal', 'green', 'amber', 'coral', 'rose', 'violet', 'indigo', 'cyan'] as const;
export type ProjectColor = typeof PROJECT_COLORS[number];
export function projectColor(value: string | null | undefined): ProjectColor {
  return PROJECT_COLORS.find((color) => color === value) ?? 'blue';
}
/** A missing owner is neutral, not the selected project's accent. */
export function projectColorAttribute(project: Project | null | undefined) {
  return project ? projectColor(project.color_id) : undefined;
}
