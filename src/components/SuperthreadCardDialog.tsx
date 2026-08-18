import { useEffect, useMemo, useRef, type SyntheticEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import DOMPurify from 'dompurify';
import { canStartSuperthreadWork } from '../superthread/status';
import type { SuperthreadCard } from '../superthread/types';

export function SuperthreadCardDialog({ card, status, loading, error, onRequestStartWork, onClose }: {
  card: SuperthreadCard;
  status: string | undefined;
  loading: boolean;
  error: string | null;
  onRequestStartWork: (card: SuperthreadCard) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const sanitizedContent = useMemo(() => DOMPurify.sanitize(card.content, {
    FORBID_TAGS: ['img', 'style'],
    FORBID_ATTR: ['style'],
  }), [card.content]);

  useEffect(() => {
    requestAnimationFrame(() => closeRef.current?.focus());
  }, [card.id]);

  return (
    <div className="modalBackdrop" onMouseDown={onClose}>
      <div
        className="modal superthreadCardDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="superthread-card-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="superthreadCardDialogMeta">
          {card.board_title} • {card.list_title} •{' '}
          {card.card_url ? (
            <a href={card.card_url} onClick={(event) => openExternalLink(event, card.card_url)}>#{card.id}</a>
          ) : `#${card.id}`}
        </div>
        <h2 id="superthread-card-title">{card.title}</h2>
        {loading ? (
          <div className="superthreadState">Loading card…</div>
        ) : error ? (
          <div className="superthreadState superthreadError">{error}</div>
        ) : (
          <>
            {card.content ? (
              <div
                className="superthreadCardContent"
                dangerouslySetInnerHTML={{ __html: sanitizedContent }}
                onClick={(event) => {
                  const anchor = (event.target as HTMLElement).closest('a');
                  if (anchor) openExternalLink(event, anchor.getAttribute('href') ?? '');
                }}
              />
            ) : (
              <div className="superthreadCardContent superthreadCardContentEmpty">No description.</div>
            )}
            <div className="superthreadCardStats">
              {card.assignee_names.length > 0 && (
                <>
                  <span>{card.assignee_names.join(', ')}</span>
                  <span>•</span>
                </>
              )}
              <span>{card.total_comments} {card.total_comments === 1 ? 'comment' : 'comments'}</span>
            </div>
          </>
        )}
        <div className="modalActions">
          <button ref={closeRef} type="button" onClick={onClose}>Close</button>
          {canStartSuperthreadWork(status) && (
            <button className="primaryAction" type="button" onClick={() => onRequestStartWork(card)}>Start Work</button>
          )}
        </div>
      </div>
    </div>
  );
}

function openExternalLink(event: SyntheticEvent, url: string) {
  event.preventDefault();
  if (url.startsWith('http://') || url.startsWith('https://')) {
    invoke('open_url', { url }).catch(console.error);
  }
}
