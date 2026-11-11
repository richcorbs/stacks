import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { declarationsFor, parseCss } from './test/cssParser.mjs';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('global stylesheet architecture', () => {
  it('orders the cascade explicitly, including vendor CSS', () => {
    expect(css).toContain('@layer reset, tokens, vendor, components, states;');
    expect(css).toContain('@import "@xterm/xterm/css/xterm.css" layer(vendor);');
    const root = postcss.parse(css);
    expect(root.nodes.filter((node) => node.type === 'rule')).toHaveLength(0);
    expect(declarationsFor(css, ':where(button)')).toContain('font-size: var(--fs-12)');
  });

  it('defines interface calculations once at root and never in font declarations', () => {
    const tokens = declarationsFor(css, ':root');
    for (const size of [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 24, 25]) {
      expect(tokens).toContain(`--fs-${size}: calc(${size}px + var(--ui-font-delta, 0px))`);
    }
    postcss.parse(css).walkDecls((decl) => {
      if (!['font', 'font-size'].includes(decl.prop)) return;
      expect(decl.value).not.toContain('--ui-font-delta');
      expect(decl.value).not.toMatch(/^(?:\d+\s+)?\d+px(?:\b|\/)/);
    });
    expect(declarationsFor(css, '.piMessageText')).toContain('var(--pi-font-size, 13px)');
    expect(declarationsFor(css, '.piMarkdown table')).not.toContain('--fs-');
    expect(declarationsFor(css, '.diffCode')).toContain('var(--diff-font-size, 11px)');
  });

  it('gives every project color one complete derived palette', () => {
    const palette = declarationsFor(css, '[data-project-color]');
    expect(palette).toContain('--project-badge-color: color-mix(');
    expect(palette).toContain('--project-card-hover-surface: color-mix(');
    for (const color of ['blue', 'slate', 'teal', 'green', 'amber', 'coral', 'rose', 'violet', 'indigo', 'cyan']) {
      expect(declarationsFor(css, `[data-project-color="${color}"]`).trim()).toMatch(/^--project-accent: #[\da-f]{6};$/);
    }
    expect(css).not.toContain(':not([data-project-color="blue"])');
    expect(css).not.toContain(':not(.primaryAction)');
    expect(css).not.toContain(':not(.danger)');
  });

  it('never repeats an individual selector in the same layer and conditional context', () => {
    const seen = new Set();
    for (const rule of parseCss(css)) {
      for (const selector of postcss.list.comma(rule.selector)) {
        const key = JSON.stringify([rule.context, selector]);
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe('layer-aware CSS assertions', () => {
  const fixture = `@layer reset, components;
    @layer components {
      /* braces { in comments } cannot create rules */
      .example { content: "}"; background: url("data:image/svg+xml,<svg>{}</svg>"); }
      @media (max-width: 800px) { .example { display: grid; } }
      @supports (display: grid) { .example { display: flex; } }
      @keyframes spin { to { transform: rotate(360deg); } }
    }`;
  it('keeps conditionals addressable instead of flattening their declarations', () => {
    expect(declarationsFor(fixture, '.example')).toContain('content: "}"');
    expect(declarationsFor(fixture, '.example', ['@media (max-width: 800px)'])).toContain('display: grid');
    expect(declarationsFor(fixture, '.example', ['@supports (display: grid)'])).toContain('display: flex');
    expect(parseCss(fixture)).toHaveLength(3);
  });
  it('still checks the real responsive overrides', () => {
    expect(declarationsFor(css, '.kanbanHeader', ['@media (max-width: 800px)'])).toContain('flex-wrap: wrap');
    expect(declarationsFor(css, '.kanbanHeader')).not.toContain('flex-wrap: wrap');
  });
});
