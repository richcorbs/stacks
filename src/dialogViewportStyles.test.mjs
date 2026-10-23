import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rule = (selector) => css.slice(css.indexOf(`${selector} {`)).split('}')[0];
const component = (path) => readFileSync(new URL(`./components/${path}.tsx`, import.meta.url), 'utf8');

describe('window-constrained dialogs', () => {
  it('caps the border box, not just content, and keeps small dialogs naturally sized', () => {
    const modal = rule('.modal');
    expect(modal).toContain('box-sizing: border-box');
    expect(modal).toContain('max-height: min(80dvh, 100%)');
    expect(modal).toContain('max-width: 100%');
    expect(modal).toContain('flex-direction: column');
    expect(modal).not.toMatch(/\sheight:/);
    expect(rule('.dialogBody')).toContain('min-height: 0');
    expect(rule('.dialogBody')).toContain('overflow: auto');
  });

  it('reserves safe outer spacing without changing card-detail backdrops', () => {
    const backdrop = rule('.modalBackdrop:not(.kanbanDetailBackdrop)');
    expect(backdrop).toContain('padding: 16px');
    expect(backdrop).toContain('grid-template-rows: minmax(0, 1fr)');
    expect(rule('.modalBackdrop')).not.toContain('padding:');
    expect(rule('.modalBackdrop.kanbanDetailBackdrop')).toContain('padding: 16px');
    expect(rule('.kanbanDetail')).not.toContain('80dvh');
  });

  it('reconciles specialized sizing and wrapping rather than overriding the cap', () => {
    expect(rule('.settingsModal')).toContain('height: min(720px, 80dvh)');
    expect(rule('.settingsContent')).toContain('overflow: hidden');
    expect(rule('.settingsPageBody')).toContain('flex: 1');
    expect(rule('.settingsPageActions')).not.toContain('sticky');
    for (const selector of ['.modalActions', '.settingsPageActions', '.piExtensionActions', '.kanbanNewCardActionButtons']) {
      expect(rule(selector)).toContain('flex-wrap: wrap');
    }
    // Updater actions can be wrapped in a display:contents ConfirmationBoundary.
    expect(rule('.modalActions')).toContain('flex-shrink: 0');
    expect(rule('.cleanupPreflightModal')).not.toContain('max-height:');
    for (const selector of ['.settingsPrompt', '.piExtensionDialog']) {
      expect(rule(selector)).toContain('max-height: min(80dvh, 100%)');
      expect(rule(selector)).toContain('overflow: hidden');
    }
    for (const selector of ['.settingsPromptBackdrop', '.piExtensionOverlay']) {
      expect(rule(selector)).toContain('minmax(0, 1fr) / minmax(0, 1fr)');
    }
  });

  it('separates scroll bodies from actions in all form and confirmation variants', () => {
    for (const path of ['Dialogs', 'ConfirmDialogs', 'OneTimeCommandDialog', 'AppUpdater', 'PiGuiView', 'SettingsDialog', 'kanban/NewCardDialog', 'kanban/BoardPrMergeDialog', 'kanban/ServerHandoffDialog', 'kanban/CleanupPreflightDialog']) {
      expect(component(path), path).toContain('dialogBody');
    }
    expect(component('Dialogs')).toContain('showHeading={false}');
    expect(component('SettingsDialog')).toMatch(/<\/div>\s*<div className="settingsPageActions">/);
    expect(component('PiGuiView')).toMatch(/<\/div>\s*<div className="piExtensionActions">/);
  });
});
