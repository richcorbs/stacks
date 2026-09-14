export function AsyncButtonLabel({ idle, busy, isBusy }: {
  idle: string;
  busy: string;
  isBusy: boolean;
}) {
  return (
    <span className="asyncButtonLabel">
      <span aria-hidden={isBusy}>{idle}</span>
      <span aria-hidden={!isBusy}>{busy}</span>
    </span>
  );
}
