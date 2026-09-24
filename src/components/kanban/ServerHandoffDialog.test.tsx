import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ServerHandoffDialog } from './ServerHandoffDialog';

describe('ServerHandoffDialog', () => {
  it('renders the required handoff message and actions', () => {
    const markup = renderToStaticMarkup(<ServerHandoffDialog externalId="184" busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(markup).toContain('Shutdown the server running on card #184?');
    expect(markup).toContain('>Cancel</button>');
    expect(markup).toContain('>Shutdown and start</button>');
    expect(markup).toContain('role="alertdialog"');
  });
});
