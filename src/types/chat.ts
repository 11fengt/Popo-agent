export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'idle' | 'streaming' | 'done' | 'error';
export type ToolStatus = 'pending' | 'running' | 'success' | 'error';

export interface Citation {
  id: string;
  title: string;
  snippet: string;
  source: string;
  score?: number;
}

export interface ToolInvocation {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status: MessageStatus;
  citations?: Citation[];
  tools?: ToolInvocation[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface KnowledgeDocument {
  id: string;
  name: string;
  createdAt: number;
}

export interface BackendStreamEvent {
  type: 'token' | 'tool' | 'citations' | 'done' | 'error';
  token?: string;
  citations?: Citation[];
  tool?: ToolInvocation;
  tools?: ToolInvocation[];
  message?: string;
  details?: string;
  code?: string;
}

export interface ApiErrorPayload {
  error: string;
  details?: string;
  code?: string;
}

export interface QwenMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ServerDocumentResponse {
  id: string;
  name: string;
  createdAt: number;
}
