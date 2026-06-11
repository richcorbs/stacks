import { useEffect } from 'react';

export function useAppWindowFocusClass() {
  useEffect(() => {
    const update = () => {
      document.body.classList.toggle('appWindowInactive', !document.hasFocus());
    };
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      document.body.classList.remove('appWindowInactive');
    };
  }, []);
}
