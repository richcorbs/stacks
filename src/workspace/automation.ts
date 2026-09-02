export type AutomationRequest = {
  requestId: string;
  action: string;
  name: string;
  startupCommand?: string | null;
  runOnce?: string | null;
};

export type AutomationResponse = {
  ok: boolean;
  message: string;
  workspaceId: string | null;
  exitCode?: number | null;
};
