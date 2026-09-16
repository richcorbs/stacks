import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { CardLevelErrorBanner, collectCardLevelErrors } from './CardLevelErrorBanner';

describe('card-level errors', () => {
  it('aggregates and deduplicates current errors while preserving reload requirements', () => {
    expect(collectCardLevelErrors({
      actionError: 'Card environment changed; reload before approving',
      detailLoadError: 'Card environment changed; reload before approving',
      recoveryError: 'Setup completion is ambiguous',
    })).toEqual([
      { message: 'Card environment changed; reload before approving', requiresReload: true },
      { message: 'Setup completion is ambiguous', requiresReload: false },
    ]);
  });

  it('marks detail, environment, and layout errors for reload but not unrelated errors', () => {
    expect(collectCardLevelErrors({ actionError: 'Commit verification failed', detailLoadError: null })).toEqual([
      { message: 'Commit verification failed', requiresReload: false },
    ]);
    expect(collectCardLevelErrors({ actionError: 'Card layout changed; reload before saving', detailLoadError: null })[0].requiresReload).toBe(true);
    expect(collectCardLevelErrors({ actionError: null, detailLoadError: 'Network unavailable' })).toEqual([
      { message: 'Card details could not be loaded: Network unavailable', requiresReload: true },
    ]);
  });

  it('renders one subdued alert containing all messages and a conditional reload control', () => {
    const markup = renderToStaticMarkup(<CardLevelErrorBanner
      errors={[
        { message: 'Commit verification failed', requiresReload: false },
        { message: 'Could not load card', requiresReload: true },
      ]}
      reloading={false}
      onReload={() => undefined}
    />);

    expect(markup.match(/role="alert"/g)).toHaveLength(1);
    expect(markup).toContain('class="cardLevelErrorBanner"');
    expect(markup).toContain('Commit verification failed');
    expect(markup).toContain('Could not load card');
    expect(markup).toContain('Reload card');
  });

  it('omits the reload control for action and recovery errors', () => {
    const markup = renderToStaticMarkup(<CardLevelErrorBanner
      errors={collectCardLevelErrors({ actionError: 'Commit failed', detailLoadError: null, recoveryError: 'Recovery failed' })}
      reloading={false}
      onReload={() => undefined}
    />);

    expect(markup).not.toContain('Reload card');
    expect(markup).toContain('Commit failed');
    expect(markup).toContain('Recovery failed');
  });

  it('retains reload busy and disabled behavior', async () => {
    const onReload = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<CardLevelErrorBanner
        errors={[{ message: 'Could not load card', requiresReload: true }]}
        reloading
        onReload={onReload}
      />);
    });

    const button = renderer.root.findByType('button');
    expect(button.props.disabled).toBe(true);
    const visibleLabel = renderer.root.findAllByType('span').find((span) => span.props['aria-hidden'] === false);
    expect(visibleLabel?.children).toEqual(['Reloading…']);
  });

  it('renders no banner for informational or absent states', () => {
    expect(renderToStaticMarkup(<CardLevelErrorBanner errors={[]} reloading={false} onReload={() => undefined} />)).toBe('');
    const errors = collectCardLevelErrors({ actionError: null, detailLoadError: null, recoveryError: null });
    expect(errors).toEqual([]);
    expect(JSON.stringify(errors)).not.toContain('A new environment is required to resume work.');
    expect(JSON.stringify(errors)).not.toContain('Working…');
  });
});
