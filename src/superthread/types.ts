export type SuperthreadCardStatus = 'backlog' | 'committed' | 'started' | 'completed' | 'cancelled';

export type SuperthreadList = {
  id: string;
  title: string;
  behavior: SuperthreadCardStatus | string;
};

export type SuperthreadCard = {
  id: string;
  title: string;
  content: string;
  list_id: string;
  list_title: string;
  board_id: string;
  board_title: string;
  total_comments: number;
  assignee_names: string[];
  card_url: string;
};

export type SuperthreadBoard = {
  id: string;
  title: string;
  lists: SuperthreadList[];
  cards: SuperthreadCard[];
};

export type IntegrationWarning = {
  scope: string;
  message: string;
};

export type SuperthreadBoardsResponse = {
  boards: Array<Pick<SuperthreadBoard, 'id' | 'title'>>;
  warnings: IntegrationWarning[];
};
