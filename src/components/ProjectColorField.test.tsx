import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef } from 'react';
import { DialogFields } from './DialogFields';
import { projectColor, projectColorAttribute, PROJECT_COLORS } from '../projectColor';

describe('project color picker', () => {
  it('renders labeled native radios with a selected default and a draft-only selection', () => {
    const dialog = { kind: 'project' as const, name: 'Example', path: '/example' };
    const render = (colorId?: string) => renderToStaticMarkup(<DialogFields dialog={{ ...dialog, colorId }} setDialog={() => {}} firstInputRef={createRef<HTMLInputElement>()} />);
    const initial = render();
    expect(initial).toContain('<legend>Project accent color</legend>');
    expect(initial.match(/type="radio"/g)).toHaveLength(PROJECT_COLORS.length);
    expect(initial).toMatch(/checked="" value="blue"/);
    expect(initial).toContain('aria-label="teal project accent"');
    expect(render('teal')).toMatch(/checked="" value="teal"/);
    expect(render()).toBe(initial); // Reopening the original draft restores blue.
  });
  it('validates DOM IDs and does not color unassigned content', () => {
    expect(projectColor('evil')).toBe('blue');
    expect(projectColorAttribute(null)).toBeUndefined();
    expect(projectColorAttribute({ id: 'one', name: 'One', path: '/one', workspaces: [], color_id: 'coral' })).toBe('coral');
  });
});
