import { parseCss } from './test/cssParser.mjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rules = parseCss(css);
const scope = '.kanbanDetail.cardWorkspace[data-project-color] button';
function body(selector) {
  const rule = rules.find((rule) => rule.selector === selector);
  expect(rule, `Missing ${selector}`).toBeDefined();
  return rule.body;
}

describe('card detail action styling contracts', () => {
  it('uses owner-derived surfaces and text without overriding disabled opacity', () => {
    for (const variant of ['primary', 'secondary']) {
      const declarations = body(`${scope}[data-card-action="${variant}"]`);
      expect(declarations).toContain('var(--project-accent)');
      expect(declarations).toContain('background: color-mix(');
      expect(declarations).toContain('color:');
      expect(declarations).not.toContain('opacity:');
      expect(body(`${scope}[data-card-action="${variant}"]:hover:not(:disabled)`)).toContain('background: color-mix(');
    }
  });

  it('keeps tertiary actions transparent even when primary', () => {
    expect(body(`${scope}[data-card-action="tertiary"]`)).toContain('background: transparent');
    expect(body(`${scope}[data-card-action="tertiary"]:hover:not(:disabled)`)).toContain('background: transparent');
    expect(body(`${scope}:is([data-card-action="primary"], [data-card-action="secondary"], [data-card-action="tertiary"]):focus-visible`)).toContain('outline: 2px solid var(--card-action-focus)');
  });

  it('preserves transparent neutral fallback actions when the owner is missing', () => {
    const fallback = '.kanbanDetail.cardWorkspace:not([data-project-color]) .cardFooterActions button.workflowActionNeutralGhost[data-card-action="tertiary"]';
    expect(body(fallback)).toContain('background: transparent');
    expect(body(fallback)).toContain('color: #93a4b7');
    expect(body(`${fallback}:is(:hover, :focus-visible):not(:disabled)`)).toContain('background: transparent');
  });

  it('keeps destructive actions red independently of project ownership', () => {
    const danger = '.kanbanDetail.cardWorkspace .cardFooterActions button.workflowActionDangerGhost[data-card-action="danger-tertiary"]';
    expect(body(danger)).toContain('color: #d79298');
    const interactive = body(`${danger}:is(:hover, :focus-visible):not(:disabled)`);
    expect(interactive).toContain('color: #f0aab0');
    expect(interactive).toContain('outline: 2px solid #d79298');
    expect(interactive).toContain('background: transparent');
    expect(interactive).not.toContain('--project-');
  });
});
