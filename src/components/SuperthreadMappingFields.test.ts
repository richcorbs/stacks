import { describe, expect, it } from 'vitest';
import { disambiguatedLabels } from './SuperthreadMappingFields';

describe('Superthread mapping selectors', () => {
  it('disambiguates duplicate display names with stable IDs', () => {
    const labels = disambiguatedLabels([
      { id: 'one', title: 'Incoming', behavior: 'backlog' },
      { id: 'two', title: ' incoming ', behavior: 'backlog' },
      { id: 'three', title: 'Doing', behavior: 'started' },
    ]);
    expect(labels.get('one')).toBe('Incoming · one');
    expect(labels.get('two')).toBe(' incoming  · two');
    expect(labels.get('three')).toBe('Doing');
  });
});
