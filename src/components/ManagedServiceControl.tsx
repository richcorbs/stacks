import type { SyntheticEvent } from 'react';
import type { ManagedServiceMode } from '../managedServices';
import type { useManagedServices } from '../hooks/useManagedServices';

type Services = ReturnType<typeof useManagedServices>;

/** Request acceptance is deliberately separate from PTY startup and running. */
export function ManagedServiceControl({ services, mode, className, onToggle, isolate = false }: {
  services: Services;
  mode: ManagedServiceMode;
  className: string;
  onToggle: () => void;
  isolate?: boolean;
}) {
  const active = services[`${mode}Active`];
  const pending = services[`${mode}ActionPending`];
  const starting = services[`${mode}Starting`];
  const error = services[`${mode}Error`];
  const status = pending === 'start' ? 'Start requested…'
    : pending === 'stop' ? 'Stop requested…'
      : error ? `Failed: ${error}`
        : starting ? 'Starting…' : services[`${mode}Running`] ? 'Running' : 'Stopped';
  const action = `${active ? 'Stop' : 'Start'} ${mode}`;
  const stopPropagation = (event: SyntheticEvent) => { if (isolate) event.stopPropagation(); };
  return <span className="managedServiceControl">
    <button
      className={`${className}${active ? ' running' : ''}${error ? ' failed' : ''}`}
      type="button"
      disabled={Boolean(pending)}
      aria-busy={Boolean(pending)}
      aria-label={pending ? `${mode}: ${status}` : action}
      aria-pressed={active}
      title={`${mode}: ${status}${pending ? '' : ` — ${action}`}`}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onPointerCancel={stopPropagation}
      onClick={(event) => { stopPropagation(event); onToggle(); }}
    ><span className={pending || starting ? 'serviceBusyIcon' : active ? 'serviceStopIcon' : 'servicePlayIcon'} aria-hidden="true" /></button>
    <span className={pending || starting || error ? 'managedServiceStatus' : 'managedServiceStatus srOnly'} role="status" title={status}>{status}</span>
  </span>;
}
