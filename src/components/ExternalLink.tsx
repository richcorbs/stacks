import type { ComponentPropsWithoutRef, KeyboardEvent, MouseEvent, SyntheticEvent } from 'react';
import { openExternalUrl, webUrl } from '../externalLinks';

type Props = Omit<ComponentPropsWithoutRef<'a'>, 'onClick' | 'onAuxClick' | 'onMouseDown' | 'onKeyDown' | 'target' | 'download'>;

function linkHandlers(href: string | undefined) {
  function activate(event: SyntheticEvent) {
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(href);
  }
  return {
    onClick(event: MouseEvent) {
      if (event.button === 0) activate(event);
      else event.preventDefault();
    },
    onAuxClick(event: MouseEvent) {
      // Some engines dispatch both click and auxclick for non-primary buttons.
      if (event.button === 1) activate(event);
      else event.preventDefault();
    },
    onMouseDown(event: MouseEvent) {
      // Suppress middle-button autoscroll / native link handling before auxclick.
      if (event.button === 1) event.preventDefault();
    },
    onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Enter') return;
      // Prevent the native synthetic click so Enter launches exactly once.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) void openExternalUrl(href);
    },
  };
}

/** Keep browser navigation out of the app, including modified and auxiliary clicks. */
export function ExternalLink({ href, ...props }: Props) {
  const url = webUrl(href);
  return <a {...props} href={url} role={url ? undefined : 'link'} tabIndex={0} {...linkHandlers(url)} />;
}

/** Delegation for already-sanitized provider HTML, without changing its sanitization. */
export function ExternalHtmlLinks({ html, className }: { html: string; className?: string }) {
  function handlers(event: SyntheticEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest('a');
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    return linkHandlers(anchor.getAttribute('href') ?? undefined);
  }
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }}
    onClick={(event) => handlers(event)?.onClick(event)}
    onAuxClick={(event) => handlers(event)?.onAuxClick(event)}
    onMouseDown={(event) => handlers(event)?.onMouseDown(event)}
    onKeyDown={(event) => handlers(event)?.onKeyDown(event)}
  />;
}
