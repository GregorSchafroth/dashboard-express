// src/types/voiceflow.ts
export type WebhookBody = {
  voiceflowProjectId: string;
}

export type VoiceflowPayload = {
  message?: string;
  text?: string;
  type?: 'launch';
  data?: {
    message?: string;
    text?: string;
    [key: string]: unknown;
  };
  payload?: {
    message?: string;
    text?: string;
    query?: string;
    label?: string;
    slate?: {
      content?: Array<{
        children: Array<{
          text?: string;
          type?: 'link';
          url?: string;
          fontWeight?: string;
          children?: Array<{ text: string }>;
        }>;
      }>;
    };
  };
  choices?: Array<{ name: string; actions: Array<Record<string, unknown>> }>;
  success?: boolean;
}

export type VoiceflowTurn = {
  turnID: string;
  type: string;
  payload: VoiceflowPayload;
  startTime: string;
  format: string;
}