import { AppLayout } from './components/AppLayout';
import { useAppRootModel } from './hooks/useAppRootModel';

export function AppRoot() {
  return <AppLayout {...useAppRootModel()} />;
}
