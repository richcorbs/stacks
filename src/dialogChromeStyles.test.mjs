import { describe, expect, it } from 'vitest';
import { authoredDeclaration, color, isTransparent, renderToStyle } from './test/renderToStyle.mjs';

const dialogMarkup = `<div class="modalBackdrop"><section class="modal" role="dialog">
  <h2>Add Project</h2><div class="dialogBody">Body</div>
  <div class="modalActions"><button data-card-action="primary">Save</button></div>
</section></div>`;

const updateMarkup = `<div class="modalBackdrop"><section class="modal updateModal">
  <header class="updateModalHeader"><h2 id="update-dialog-title">Stacks 0.7.0 is available</h2>
    <button class="updateReleaseNotesLink" type="button">Release Notes</button>
  </header>
  <div class="dialogBody">Notes</div>
  <div class="modalActions"><button>Later</button></div>
</section></div>
<div class="updateModalHeader"><h2 id="disabled-title">Stacks is up to date</h2>
  <button class="updateReleaseNotesLink" type="button" disabled>Release Notes</button>
</div>`;

describe('window-constrained dialogs', () => {
  it('caps the modal border box and keeps the body as the scroll port', () => {
    const { style, declaration } = renderToStyle(dialogMarkup);
    for (const [property, value] of [
      ['boxSizing', 'border-box'], ['maxWidth', '100%'], ['maxHeight', 'min(80dvh, 100%)'],
      ['flexDirection', 'column'], ['overflow', 'hidden'],
    ]) expect(style('.modal', property), property).toBe(value);
    expect(declaration('.modal', 'height')).toBe('');
    expect(style('.dialogBody', 'minHeight')).toBe('0');
    expect(style('.dialogBody', 'overflow')).toBe('auto');
  });

  it('reserves safe outer spacing without changing card-detail backdrops', () => {
    const { style } = renderToStyle(`${dialogMarkup}<div class="modalBackdrop kanbanDetailBackdrop"><div class="kanbanDetail"></div></div>`);
    expect(style('.modalBackdrop:not(.kanbanDetailBackdrop)', 'padding')).toBe('16px');
    expect(style('.modalBackdrop:not(.kanbanDetailBackdrop)', 'gridTemplateRows')).toBe('minmax(0, 1fr)');
    expect(style('.modalBackdrop.kanbanDetailBackdrop', 'padding')).toBe('16px');
    expect(style('.kanbanDetail', 'maxHeight')).not.toContain('80dvh');
  });

  it('reconciles specialized sizing and wrapping instead of overriding the cap', () => {
    const { style, declaration } = renderToStyle(`<div class="settingsModal"><div class="settingsContent"><div class="settingsPageBody"></div><div class="settingsPageActions"><button>Save</button></div></div></div>
      <div class="settingsPromptBackdrop"><div class="settingsPrompt"><div class="dialogBody"></div><div class="modalActions"></div></div></div>
      <div class="piExtensionOverlay"><div class="piExtensionDialog"><div class="dialogBody"></div><div class="piExtensionActions"></div></div></div>
      <div class="modal cleanupPreflightModal"><div class="modalActions"></div></div>
      <div class="modalActions kanbanNewCardActionButtons"></div><div class="piExtensionActions"></div>`);
    // jsdom's CSSOM drops min()/calc() width/height declarations, so read the authored value.
    expect(authoredDeclaration('.settingsModal', 'height')).toBe('min(720px, 80dvh)');
    expect(style('.settingsContent', 'overflow')).toBe('hidden');
    expect(style('.settingsPageBody', 'flexGrow')).toBe('1');
    expect(declaration('.settingsPageActions', 'position')).not.toContain('sticky');
    for (const selector of ['.modalActions', '.settingsPageActions', '.piExtensionActions', '.kanbanNewCardActionButtons']) {
      expect(style(selector, 'flexWrap'), selector).toBe('wrap');
    }
    expect(style('.modalActions', 'flexShrink')).toBe('0');
    expect(declaration('.cleanupPreflightModal', 'max-height')).toBe('');
    for (const selector of ['.settingsPrompt', '.piExtensionDialog']) {
      expect(style(selector, 'maxHeight'), selector).toBe('min(80dvh, 100%)');
      expect(style(selector, 'overflow'), selector).toBe('hidden');
    }
    for (const selector of ['.settingsPromptBackdrop', '.piExtensionOverlay']) {
      expect(style(selector, 'gridTemplate'), selector).toBe('minmax(0, 1fr) / minmax(0, 1fr)');
    }
  });
});

describe('update dialog header', () => {
  it('allows long titles to wrap inside the dialog width', () => {
    const { style } = renderToStyle(updateMarkup);
    expect(style('.updateModalHeader', 'flexWrap')).toBe('wrap');
    expect(style('.updateModalHeader', 'alignItems')).toBe('baseline');
    expect(style('.updateModalHeader h2', 'minWidth')).toBe('0');
    expect(style('.updateModalHeader h2', 'overflowWrap')).toBe('anywhere');
  });

  it('renders release notes as a smaller, underlined text link with visible focus and disabled styling', () => {
    const { style, declaration } = renderToStyle(updateMarkup);
    const link = '.updateModalHeader .updateReleaseNotesLink';
    for (const [property, value] of [
      ['fontSize', '12px'], ['textTransform', 'none'], ['textDecoration', 'underline'],
    ]) expect(style(link, property), property).toBe(value);
    expect(isTransparent(style(link, 'background'))).toBe(true);
    expect(declaration(`${link}:focus-visible`, 'outline')).toContain('2px solid');
    expect(style(`${link}:disabled`, 'opacity')).toBe('0.45');
    expect(style(`${link}:disabled`, 'cursor')).toBe('not-allowed');
  });
});

describe('overlay layering', () => {
  it('keeps details below the global terminal, standard dialogs, and the command palette', () => {
    const { declaration } = renderToStyle('');
    const zIndex = (selector) => Number(declaration(selector, 'z-index'));
    const detail = zIndex('.modalBackdrop.kanbanDetailBackdrop');
    const terminal = zIndex('.globalTerminalOverlay');
    const modal = zIndex('.modalBackdrop');
    const palette = zIndex('.paletteBackdrop');
    expect(detail).toBeLessThan(terminal);
    expect(terminal).toBeLessThan(modal);
    expect(modal).toBeLessThan(palette);
  });
});

describe('Pi composer and path menu', () => {
  it('uses the pane-width inset for the composer with extra bottom breathing room', () => {
    const { style } = renderToStyle('<div class="piGuiPane"><div class="piComposer"></div><div class="piGuiFooter"><span></span></div></div>');
    expect(style('.piGuiPane', '--pi-composer-inset')).toBe('max(18px, 7cqw)');
    expect(style('.piGuiPane', '--pi-composer-bottom-inset')).toContain('calc(');
    expect(style('.piGuiPane', 'containerType')).toBe('inline-size');
    expect(style('.piComposer', 'margin')).toContain('max(18px, 7cqw)');
    expect(style('.piGuiFooter', 'height')).toContain('calc(');
    expect(style('.piGuiFooter > *', 'position')).toBe('relative');
    expect(style('.piGuiFooter > *', 'top')).toBe('-1px');
  });

  it('uses the fixed card-chat inset inside open cards', () => {
    const { style } = renderToStyle('<div class="cardChat"><div class="piGuiPane"></div></div>');
    expect(style('.cardChat .piGuiPane', '--pi-composer-inset')).toBe('24px');
  });

  it('keeps path completion rows in natural casing without changing the command menu', () => {
    const { style } = renderToStyle('<button id="global">Action</button><div class="piPathMenu"><button>src/App.tsx</button></div><div class="piCommandMenu"><button>Command</button></div>');
    expect(style('#global', 'textTransform')).toBe('uppercase');
    expect(style('.piPathMenu button', 'textTransform')).toBe('none');
    expect(style('.piCommandMenu button', 'textTransform')).toBe('uppercase');
  });
});

describe('top-level terminal chrome', () => {
  it('hides the overlay until visible and keeps an icon-only dismiss control at the far edge', () => {
    const { style, declaration, token } = renderToStyle('<section class="globalTerminalOverlay"><nav class="globalTerminalTabs"><button class="globalTerminalDismiss"><span aria-hidden="true">×</span></button></nav></section>');
    expect(style('.globalTerminalOverlay', 'visibility')).toBe('hidden');
    expect(isTransparent(style('.globalTerminalOverlay', 'backgroundColor'))).toBe(false);
    expect(declaration('.globalTerminalOverlay.visible', 'visibility')).toBe('visible');
    expect(style('.globalTerminalTabs', 'flex')).toBe('0 0 42px');
    expect(style('.globalTerminalDismiss', 'width')).toBe('30px');
    expect(style('.globalTerminalDismiss', 'height')).toBe('30px');
    expect(style('.globalTerminalDismiss', 'marginLeft')).toBe('auto');
    expect(style('.globalTerminalDismiss', 'display')).toBe('grid');
    expect(color(style('.globalTerminalOverlay', 'backgroundColor'))).toBe(color(token('--surface-canvas')));
  });
});
