import { describe, expect, it } from 'vitest';
import { disambiguatedLabels, SUPERTHREAD_MAPPING_VALIDATED_MESSAGE } from './SuperthreadMappingFields';

describe('Superthread mapping selectors', () => {
  it('tells users that successful validation must still be saved', () => {
    expect(SUPERTHREAD_MAPPING_VALIDATED_MESSAGE).toBe('Configuration validated. Save to activate Superthread synchronization.');
  });

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
