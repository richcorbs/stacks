import { AppLayout } from './components/AppLayout';
import { AppUpdater } from './components/AppUpdater';
import { useAppRootModel } from './hooks/useAppRootModel';

export function AppRoot() {
  const model = useAppRootModel();
  return <>
    <AppLayout {...model} />
    <AppUpdater />
  </>;
}
