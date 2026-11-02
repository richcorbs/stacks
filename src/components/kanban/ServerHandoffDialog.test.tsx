import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ServerHandoffDialog } from './ServerHandoffDialog';

describe('ServerHandoffDialog', () => {
  it('renders the required handoff message and actions', () => {
    const markup = renderToStaticMarkup(<ServerHandoffDialog externalId="184" busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(markup).toContain('Shutdown the server running on card #184?');
    expect(markup).toContain('>Cancel</button>');
    expect(markup).toContain('<span>Shutdown and start</span>');
    expect(markup).toContain('<span> (2)</span>');
    expect(markup).toContain('role="alertdialog"');
  });
});
