import type { PiUiRequest } from '../pi/types';

type StructuredRequest = PiUiRequest & { method: 'confirm' | 'select' };

export function isStructuredPiUiRequest(request: PiUiRequest | null): request is StructuredRequest {
  return request?.method === 'confirm' || request?.method === 'select';
}

export function PiStructuredRequest({ request, onRespond }: {
  request: StructuredRequest;
  onRespond: (requestId: string, response: Record<string, unknown>) => void;
}) {
  const respond = (response: Record<string, unknown>) => onRespond(request.id, response);
  return <section className="piStructuredRequest" aria-label={request.title}>
    <strong>{request.title}</strong>
    {request.message && <p>{request.message}</p>}
    <div className="piStructuredRequestActions">
      {request.method === 'confirm'
        ? <>
          <button type="button" aria-label={`${request.title}: Yes`} onClick={() => respond({ confirmed: true })}>Yes</button>
          <button type="button" aria-label={`${request.title}: No`} onClick={() => respond({ confirmed: false })}>No</button>
        </>
        : request.options.map((option, index) => <button
          type="button"
          aria-label={`${request.title}: ${option}`}
          key={`${option}:${index}`}
          onClick={() => respond({ value: option })}
        >{option}</button>)}
    </div>
  </section>;
}
