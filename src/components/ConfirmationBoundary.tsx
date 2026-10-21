import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement, type FormEvent, type MouseEvent } from 'react';

type LayoutProps = {
  children?: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown;
  onSubmit?: (event: FormEvent) => unknown;
  'data-confirm-cancel'?: boolean;
  'aria-label'?: string;
};

function isVisible(root: HTMLElement | null): root is HTMLElement {
  if (!root?.isConnected) return false;
  for (let parent: HTMLElement | null = root; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (parent.hidden || parent.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function isActive(root: HTMLElement | null): root is HTMLElement {
  if (!isVisible(root)) return false;
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"], [aria-modal="true"], .confirmModal')).filter(isVisible);
  const top = dialogs.at(-1);
  return !top || root.contains(top) || top.contains(root);
}

export function hasActiveConfirmation() {
  return typeof document !== 'undefined' && Array.from(document.querySelectorAll<HTMLElement>('[data-confirmation-boundary]')).some(isActive);
}

/**
 * Gate intrinsic buttons and form handlers in a confirmation's layout, preserving
 * each domain's validation/busy rules. Custom action components belong inside a
 * button, not around it. Ordinary edit/create layouts must not use this boundary.
 */
export function ConfirmationBoundary({ children }: { children: ReactNode }) {
  const [remaining, setRemaining] = useState(2);
  const ready = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ready.current = false;
    setRemaining(2);
    if (isActive(root.current)) root.current.querySelector<HTMLButtonElement>('button[data-confirm-cancel]:not(:disabled)')?.focus();
    const one = setTimeout(() => setRemaining(1), 1000);
    const two = setTimeout(() => { ready.current = true; setRemaining(0); }, 2000);
    return () => { ready.current = false; clearTimeout(one); clearTimeout(two); };
  }, []);
  useLayoutEffect(() => {
    if (remaining || !isActive(root.current)) return;
    root.current.querySelector<HTMLButtonElement>('button.primaryAction:not(:disabled), button[data-dialog-primary]:not(:disabled), button[type="submit"]:not(:disabled)')?.focus();
  }, [remaining]);

  function gate(nodes: ReactNode): ReactNode {
    return Children.map(nodes, (node) => {
      if (!isValidElement(node)) return node;
      const element = node as ReactElement<LayoutProps>;
      const props = element.props;
      const patch: Partial<LayoutProps> = {};
      if (element.type === 'button') {
        const cancel = props['data-confirm-cancel'] || (typeof props.children === 'string' && /^(Cancel|Close|No)$/.test(props.children));
        if (cancel) patch['data-confirm-cancel'] = true;
        else {
          patch.disabled = !!props.disabled || remaining > 0;
          // Guard the actual callback as well as native button activation.
          patch.onClick = (event) => {
            if (!ready.current || props.disabled) { event?.preventDefault(); return; }
            return props.onClick?.(event);
          };
          patch.children = remaining > 0 ? <>{props.children}{` (${remaining})`}</> : props.children;
          if (props['aria-label'] && remaining > 0) patch['aria-label'] = `${props['aria-label']} (${remaining})`;
        }
        patch.autoFocus = false;
      }
      if (props.onSubmit) patch.onSubmit = (event) => {
        event.preventDefault();
        if (ready.current) return props.onSubmit?.(event);
      };
      if (!('children' in patch) && props.children) patch.children = gate(props.children);
      return cloneElement(element, patch);
    });
  }
  return <div ref={root} data-confirmation-boundary style={{ display: 'contents' }} onKeyDown={(event) => event.stopPropagation()}>{gate(children)}</div>;
}
