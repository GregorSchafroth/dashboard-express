// src/services/transcriptDetail.ts
import logger from '../utils/logger.js'
import { withRetry } from '../utils/retry.js'
import prisma from '../lib/prisma.js'
import type { Prisma } from '@prisma/client'
import axios from 'axios'
import { analyzeTranscript } from './openai.js'

export type VoiceflowTurn = {
  turnID: string
  type: string
  payload: Record<string, unknown>
  startTime: string
  format: string
}

export async function getTranscriptContent(
  transcriptId: string,
  voiceflowProjectId: string,
  apiKey: string
): Promise<VoiceflowTurn[]> {
  const url = `https://api.voiceflow.com/v2/transcripts/${voiceflowProjectId}/${transcriptId}`

  return await withRetry(
    async () => {
      try {
        const response = await axios.get(url, {
          headers: {
            accept: 'application/json',
            Authorization: apiKey,
            'Cache-Control': 'no-cache',
          },
        })

        if (!Array.isArray(response.data)) {
          logger.error('Unexpected transcript content format', {
            transcriptId,
            received: typeof response.data,
            content: response.data,
          })
          return []
        }

        // Sort turns by startTime to ensure correct order
        const sortedTurns = response.data.sort(
          (a, b) =>
            new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
        )

        logger.prisma('Fetched transcript content', {
          transcriptId,
          turnsCount: sortedTurns.length,
        })

        return sortedTurns
      } catch (error) {
        if (axios.isAxiosError(error)) {
          logger.error('Transcript content fetch failed', {
            status: error.response?.status,
            transcriptId,
            projectId: voiceflowProjectId,
            error: error.response?.data,
          })
        }
        throw error
      }
    },
    3,
    1000
  )
}

function calculateTranscriptMetrics(turns: VoiceflowTurn[]) {
  const sortedTurns = [...turns].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  )

  const messageCount = sortedTurns.filter(
    (turn) => turn.type === 'text' || turn.type === 'request'
  ).length

  const timestamps = sortedTurns.map((turn) => new Date(turn.startTime))
  const firstResponse =
    timestamps.length > 0
      ? new Date(Math.min(...timestamps.map((date) => date.getTime())))
      : null
  const lastResponse =
    timestamps.length > 0
      ? new Date(Math.max(...timestamps.map((date) => date.getTime())))
      : null

  const duration =
    firstResponse && lastResponse
      ? Math.round((lastResponse.getTime() - firstResponse.getTime()) / 1000)
      : null

  const lastTurn = sortedTurns[turns.length - 1]
  const isComplete =
    lastTurn?.type === 'choice' ||
    (lastTurn?.type === 'text' &&
      !turns.some(
        (t) =>
          t.type === 'request' &&
          new Date(t.startTime) > new Date(lastTurn.startTime)
      ))

  return {
    messageCount,
    firstResponse,
    lastResponse,
    duration,
    isComplete,
  }
}

export async function saveTranscriptTurns(
  transcriptId: number,
  turns: VoiceflowTurn[]
) {
  const metrics = calculateTranscriptMetrics(turns)

  // Get OpenAI analysis
  const analysis = await analyzeTranscript(turns)

  await prisma.$transaction(
    async (tx) => {
      // Update transcript with metrics and analysis
      await tx.transcript.update({
        where: { id: transcriptId },
        data: {
          messageCount: metrics.messageCount,
          firstResponse: metrics.firstResponse,
          lastResponse: metrics.lastResponse,
          duration: metrics.duration,
          isComplete: metrics.isComplete,
          language: analysis.language,
          topic: analysis.topic,
          topicTranslations: analysis.topicTranslations,
          name: analysis.name,
        },
      })

      // First, delete any existing turns to prevent duplicates
      await tx.turn.deleteMany({
        where: { transcriptId },
      })

      // Create turns with explicit ordering
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]
        await tx.turn.create({
          data: {
            transcriptId,
            type: turn.type,
            payload: turn.payload as Prisma.InputJsonValue,
            startTime: new Date(turn.startTime),
            format: turn.format,
            voiceflowTurnId: turn.turnID,
          },
        })
      } // First, delete any existing turns to prevent duplicates
      await tx.turn.deleteMany({
        where: { transcriptId },
      })

      // Create turns with explicit ordering
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]
        await tx.turn.create({
          data: {
            transcriptId,
            type: turn.type,
            payload: turn.payload as Prisma.InputJsonValue,
            startTime: new Date(turn.startTime),
            format: turn.format,
            voiceflowTurnId: turn.turnID,
          },
        })
      }
    },
    {
      timeout: 30000, // Increased timeout to account for OpenAI analysis
    }
  )

  logger.prisma('Saved transcript with analysis and turns', {
    transcriptId,
    turnCount: turns.length,
    metrics,
    analysis,
  })
}
