import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AsyncButtonLabel } from './AsyncButtonLabel';

describe('AsyncButtonLabel', () => {
  it.each([
    [false, 'false', 'true'],
    [true, 'true', 'false'],
  ])('only exposes the active label when isBusy is %s', (isBusy, idleHidden, busyHidden) => {
    const markup = renderToStaticMarkup(
      <button><AsyncButtonLabel idle="Save" busy="Saving…" isBusy={isBusy} /></button>,
    );

    expect(markup).toContain(`<span aria-hidden="${idleHidden}">Save</span>`);
    expect(markup).toContain(`<span aria-hidden="${busyHidden}">Saving…</span>`);
  });
});
