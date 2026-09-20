export type SuperthreadCardStatus = 'backlog' | 'committed' | 'started' | 'completed' | 'cancelled';

export type SuperthreadList = {
  id: string;
  title: string;
  behavior: SuperthreadCardStatus | string;
};

export type SuperthreadTaskChild = {
  task_id: string;
  title: string;
  status?: SuperthreadCardStatus | string;
};

export type SuperthreadCard = {
  id: string;
  title: string;
  content: string | null;
  list_id: string;
  list_title: string;
  board_id: string;
  board_title: string;
  total_comments: number;
  assignee_names: string[];
  card_url: string;
  task_parent?: { id: string; title: string } | null;
  /** Present on a complete card detail response, including as an empty array. */
  task_children?: SuperthreadTaskChild[] | null;
  total_task_children?: number;
};

export type SuperthreadBoard = {
  id: string;
  title: string;
  lists: SuperthreadList[];
  cards: SuperthreadCard[];
};

export type SuperthreadSpace = { id: string; title: string };
export type SuperthreadConnectionResult = {
  workspace_id: string;
  workspace_name: string;
  workspace_slug?: string | null;
  spaces: SuperthreadSpace[];
};

export type IntegrationWarning = {
  scope: string;
  message: string;
};

export type SuperthreadBoardsResponse = {
  boards: Array<Pick<SuperthreadBoard, 'id' | 'title'>>;
  successful_space_ids: string[];
  warnings: IntegrationWarning[];
  complete: boolean;
};

export type CreateSuperthreadCardRequest = {
  boardId: string;
  apiTokenEnvVar: string;
  listId: string;
  workspaceSlug: string;
  title: string;
  content: string;
};

export type SuperthreadMappingDraft = {
  spaces: string;
  api_token_env_var: string;
  board_id: string;
  incoming_column_ids: string[];
  default_incoming_column_id: string;
  in_progress_column_id: string;
  done_column_id: string;
};

export type SuperthreadMappingTestResult = {
  workspace_id: string;
  workspace_name: string;
  space_id: string;
  space_name: string;
  workspace_slug?: string | null;
  board_id: string;
  board_name: string;
  incoming_columns: Array<{ id: string; name: string }>;
  default_incoming_column_id: string;
  in_progress_column_id: string;
  in_progress_column_name: string;
  done_column_id: string;
  done_column_name: string;
};
