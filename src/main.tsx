import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { AppRoot } from './AppRoot';

createRoot(document.getElementById('root')!).render(<AppRoot />);
