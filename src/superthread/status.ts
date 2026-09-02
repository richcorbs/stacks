export function canStartSuperthreadWork(status: string | undefined) {
  return status === 'backlog' || status === 'committed';
}
