export type ChatMessageStatus = 'streaming' | 'complete' | 'error';

export type ChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  status: ChatMessageStatus;
  createdAt: string;
};

export type ChatConversationDetail = {
  conversation: ChatConversation;
  messages: ChatMessage[];
};
