export type PiQuickResponse = 'yes' | 'no' | 'what do you recommend?';

type QuickResponseSessionState = {
  starting: boolean;
  isStreaming: boolean;
  stopped: boolean;
};

type QuickResponseDependencies = {
  isEligible: () => boolean;
  dismissStructuredUiRequest: () => Promise<unknown>;
  prompt: (message: string, images: []) => Promise<unknown>;
};

export function canSendPiQuickResponse({ starting, isStreaming, stopped }: QuickResponseSessionState) {
  return !starting && !isStreaming && !stopped;
}

export async function sendPiQuickResponse(message: PiQuickResponse, dependencies: QuickResponseDependencies) {
  if (!dependencies.isEligible()) return false;
  await dependencies.dismissStructuredUiRequest().catch(() => {});
  if (!dependencies.isEligible()) return false;
  await dependencies.prompt(message, []);
  return true;
}
