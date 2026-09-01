export type PiPromptImage = { type: 'image'; data: string; mimeType: string; name?: string };

export type PiTextContent = { type: 'text'; text: string };
export type PiThinkingContent = { type: 'thinking'; thinking: string };
export type PiToolCallContent = { type: 'toolCall'; id?: string; name: string; arguments?: Record<string, unknown> };
export type PiContentBlock = PiTextContent | PiThinkingContent | PiToolCallContent | { type: string; [key: string]: unknown };

export type PiMessage = {
  role: string;
  content: string | PiContentBlock[];
  timestamp?: number;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  [key: string]: unknown;
};

export type PiResponseEvent = {
  type: 'response';
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: {
    messages?: PiMessage[];
    model?: { id?: string; name?: string; provider?: string; input?: string[] } | null;
    thinkingLevel?: string;
    sessionId?: string;
    sessionName?: string;
    isStreaming?: boolean;
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
    commands?: PiCommand[];
    [key: string]: unknown;
  };
};

export type PiRpcEvent = PiResponseEvent | {
  type: string;
  message?: PiMessage | string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  id?: string;
  method?: string;
  title?: string;
  prefill?: string;
  options?: string[];
  [key: string]: unknown;
};

export type PiRpcEnvelope = { pane_id: string; generation: string; event: PiRpcEvent };

export type PiSessionContext = {
  modelName: string;
  modelId: string;
  provider: string;
  thinkingLevel: string;
  sessionId: string;
  sessionName: string;
  supportsImages: boolean;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
};

export type PiCommand = {
  name: string;
  description?: string;
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
  location?: 'user' | 'project' | 'path';
  path?: string;
};

export type PiUiRequest = {
  id: string;
  method: 'confirm' | 'input' | 'editor' | 'select';
  title: string;
  message: string;
  prefill: string;
  options: string[];
  timeout?: number;
};

export type PiToolActivity = {
  id: string;
  name: string;
  args: unknown;
  partialText: string;
  status: 'running' | 'complete' | 'error';
};
