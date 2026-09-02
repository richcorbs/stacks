import { describe, expect, it } from 'vitest';
import { developerServicesShortcutState } from './developerServices';

describe('developerServicesShortcutState', () => {
  it('closes the panel when the requested tab is already focused', () => {
    expect(developerServicesShortcutState(true, 'diff', 'diff')).toEqual({
      visible: false,
      activeTab: 'diff',
    });
  });

  it('switches to the requested tab without closing the panel', () => {
    expect(developerServicesShortcutState(true, 'pull-requests', 'diff')).toEqual({
      visible: true,
      activeTab: 'diff',
    });
  });

  it('opens a hidden panel on the requested tab', () => {
    expect(developerServicesShortcutState(false, 'diff', 'diff')).toEqual({
      visible: true,
      activeTab: 'diff',
    });
  });
});
