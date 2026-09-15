import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PiUiRequest } from '../pi/types';
import { PiStructuredRequest } from './PiStructuredRequest';

function request(method: 'confirm' | 'select', options: string[] = []): PiUiRequest & { method: 'confirm' | 'select' } {
  return { id: `request-${method}`, method, title: 'Choose wisely', message: 'A little context', prefill: '', options };
}

function actionButtons(element: ReactElement<Record<string, any>>) {
  const found: ReactElement<Record<string, any>>[] = [];
  function visit(value: any) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (value.type === 'button') found.push(value);
    else visit(value.props?.children);
  }
  visit(element);
  return found;
}

describe('PiStructuredRequest', () => {
  it('renders an inline confirm with accessible Yes and No actions and exact payloads', () => {
    const onRespond = vi.fn();
    const value = request('confirm');
    const element = PiStructuredRequest({ request: value, onRespond });
    const markup = renderToStaticMarkup(element);
    const buttons = actionButtons(element);

    expect(markup).toContain('<section class="piStructuredRequest" aria-label="Choose wisely">');
    expect(markup).toContain('aria-label="Choose wisely: Yes"');
    expect(markup).toContain('aria-label="Choose wisely: No"');
    expect(markup).not.toContain('autofocus');
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    expect(onRespond.mock.calls).toEqual([
      ['request-confirm', { confirmed: true }],
      ['request-confirm', { confirmed: false }],
    ]);
  });

  it('renders and responds with every supplied select option', () => {
    const onRespond = vi.fn();
    const value = request('select', ['Alpha', 'Beta']);
    const element = PiStructuredRequest({ request: value, onRespond });
    const buttons = actionButtons(element);

    expect(buttons.map((button) => button.props.children)).toEqual(['Alpha', 'Beta']);
    buttons[1].props.onClick();
    expect(onRespond).toHaveBeenCalledWith('request-select', { value: 'Beta' });
  });
});
