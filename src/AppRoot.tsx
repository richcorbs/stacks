import { useEffect, useState } from 'react';
import { AppLayout } from './components/AppLayout';
import { AppUpdater } from './components/AppUpdater';
import { useAppRootModel } from './hooks/useAppRootModel';
import { ApplicationEventsContext, useApplicationEvents, type AppEventMap, type EventBroker } from './applicationEvents';
import { installKeyboardInteractionGate, LoadingCoordinator, LoadingCoordinatorContext } from './loadingState';

function AppContent() {
  const [loading] = useState(() => {
    const coordinator = new LoadingCoordinator();
    coordinator.beginStartup();
    return coordinator;
  });
  const [removeKeyboardGate] = useState(() => installKeyboardInteractionGate(loading));
  useEffect(() => () => { removeKeyboardGate(); loading.dispose(); }, [loading, removeKeyboardGate]);
  const model = useAppRootModel(useApplicationEvents(), loading);
  return <LoadingCoordinatorContext.Provider value={loading}>
    <AppLayout {...model} />
    <AppUpdater />
  </LoadingCoordinatorContext.Provider>;
}

export function AppRoot({ events }: { events: EventBroker<AppEventMap> }) {
  return <ApplicationEventsContext.Provider value={events}>
    <AppContent />
  </ApplicationEventsContext.Provider>;
}
