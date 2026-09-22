export type Role = 'user' | 'assistant';

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
  system?: string | ContentBlock[];
  stream?: boolean;
  metadata?: { user_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
