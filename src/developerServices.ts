export type DeveloperServicesTab = 'superthread' | 'diff' | 'pull-requests' | 'actions';

export function developerServicesShortcutState(
  visible: boolean,
  activeTab: DeveloperServicesTab,
  requestedTab: DeveloperServicesTab,
) {
  return {
    visible: !(visible && activeTab === requestedTab),
    activeTab: requestedTab,
  };
}
