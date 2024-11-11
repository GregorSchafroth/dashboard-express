// src/services/openai.ts
import OpenAI from 'openai';
import { logger } from '../utils/logger.js';
import type { VoiceflowTurn, VoiceflowPayload } from '../types/voiceflow.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export type TranscriptAnalysis = {
  language: string;
  topic: string;
  name: string;
}

function extractMessages(turns: VoiceflowTurn[]): string[] {
  const messages = turns
    .filter((turn) => turn.type === 'text' || turn.type === 'request')
    .map((turn) => {
      try {
        const payload = turn.payload;

        // For text type (AI responses)
        if (turn.type === 'text' && payload.payload?.slate?.content) {
          return payload.payload.slate.content
            .map((block) =>
              block.children
                .map((child) => {
                  if (child.type === 'link' && child.children?.[0]) {
                    return child.children[0].text;
                  }
                  return child.text || '';
                })
                .join('')
            )
            .join('\n')
            .trim();
        }

        // For request type (user messages)
        if (turn.type === 'request' && payload.payload) {
          if (payload.payload.query) return payload.payload.query;
          if (payload.payload.label) return payload.payload.label;
          if (payload.type === 'launch') return 'Conversation started';
        }

        // Fallback checks
        if (typeof payload.message === 'string') return payload.message;
        if (typeof payload.text === 'string') return payload.text;
        if (payload.data?.message) return payload.data.message;
        if (payload.data?.text) return payload.data.text;

        return '';
      } catch (error) {
        logger.error('Error extracting message from turn', error);
        return '';
      }
    })
    .filter((message) => message.length > 0);

  logger.api('Extracted messages', { count: messages.length });
  return messages;
}

export async function analyzeTranscript(turns: VoiceflowTurn[]): Promise<TranscriptAnalysis> {
  const messages = extractMessages(turns);
  const concatenatedMessages = messages.join('\n');

  if (messages.length === 0) {
    return {
      language: 'en',
      topic: '💭 Unknown Topic',
      name: 'unknown',
    };
  }

  const prompt = `Analyze the following conversation and provide:
1. The primary language used (return just the ISO 639-1 code, e.g., 'en' for English)
2. A topic summary in the format: "[relevant emoji] 3-5 word description"
   For example: "🚗 car maintenance discussion" or "📱 mobile app development"
3. Any name or identifier for this conversation that can be determined from the content. If no clear name/identifier is found, return "unknown"

The conversation includes both user and AI messages. Consider the full context of the dialogue.

Conversation:
${concatenatedMessages}

Respond in the following JSON format only:
{
  "language": "xx",
  "topic": "[emoji] brief topic here",
  "name": "conversation name or unknown"
}`;

  try {
    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'gpt-4-turbo-preview',
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const response = completion.choices[0].message.content;
    if (!response) {
      throw new Error('No response from OpenAI');
    }

    const analysis = JSON.parse(response);
    logger.api('OpenAI analysis completed', analysis);

    return {
      language: analysis.language,
      topic: analysis.topic,
      name: analysis.name,
    };
  } catch (error) {
    logger.error('OpenAI analysis failed', error);
    return {
      language: 'en',
      topic: '💭 Unknown Topic',
      name: 'unknown',
    };
  }
}