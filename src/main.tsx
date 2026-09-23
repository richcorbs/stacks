import { createRoot } from 'react-dom/client';
import './styles.css';
import { AppRoot } from './AppRoot';
import { applicationEvents } from './applicationEvents';

createRoot(document.getElementById('root')!).render(<AppRoot events={applicationEvents} />);
