import { AppLayout } from './components/AppLayout';
import { AppUpdater } from './components/AppUpdater';
import { useAppRootModel } from './hooks/useAppRootModel';
import { ApplicationEventsContext, useApplicationEvents, type AppEventMap, type EventBroker } from './applicationEvents';

function AppContent() {
  const model = useAppRootModel(useApplicationEvents());
  return <>
    <AppLayout {...model} />
    <AppUpdater />
  </>;
}

export function AppRoot({ events }: { events: EventBroker<AppEventMap> }) {
  return <ApplicationEventsContext.Provider value={events}>
    <AppContent />
  </ApplicationEventsContext.Provider>;
}
