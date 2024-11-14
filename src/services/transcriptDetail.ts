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

  const turns = await withRetry(
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

  // Additional validation to ensure all required fields are present
  return turns.filter((turn) => {
    const isValid = turn.turnID && turn.startTime && turn.type
    if (!isValid) {
      logger.error('Invalid turn data found', { turn })
    }
    return isValid
  })
}

export async function saveTranscriptTurns(
  transcriptId: number,
  turns: VoiceflowTurn[]
) {
  // Sort turns by startTime first
  const sortedTurns = [...turns].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  )

  // Calculate metrics first (this doesn't need to be in the transaction)
  const metrics = calculateTranscriptMetrics(sortedTurns)

  try {
    // Get OpenAI analysis outside the transaction
    const analysis = await analyzeTranscript(sortedTurns)

    // First transaction: Update transcript metadata
    await prisma.$transaction(
      async (tx) => {
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
      },
      {
        timeout: 5000, // Short timeout for metadata update
      }
    )

    // Second transaction: Handle turns
    await prisma.$transaction(
      async (tx) => {
        // Delete existing turns
        await tx.turn.deleteMany({
          where: { transcriptId },
        })

        // Prepare all turn data
        const turnData = sortedTurns.map((turn) => ({
          transcriptId,
          type: turn.type,
          payload: turn.payload as Prisma.InputJsonValue,
          startTime: new Date(turn.startTime),
          format: turn.format,
          voiceflowTurnId: turn.turnID,
        }))

        // Use createMany for better performance
        await tx.turn.createMany({
          data: turnData,
        })
      },
      {
        timeout: 10000, // Reasonable timeout for bulk operations
      }
    )

    logger.prisma('Saved transcript with analysis and turns', {
      transcriptId,
      turnCount: turns.length,
      metrics,
      analysis,
    })
  } catch (error) {
    logger.error('Error saving transcript turns', error)
    throw error
  }
}

function calculateTranscriptMetrics(turns: VoiceflowTurn[]) {
  const messageCount = turns.filter(
    (turn) => turn.type === 'text' || turn.type === 'request'
  ).length

  const timestamps = turns.map((turn) => new Date(turn.startTime))
  const firstResponse = timestamps.length > 0 ? timestamps[0] : null
  const lastResponse =
    timestamps.length > 0 ? timestamps[timestamps.length - 1] : null

  const duration =
    firstResponse && lastResponse
      ? Math.round((lastResponse.getTime() - firstResponse.getTime()) / 1000)
      : null

  const lastTurn = turns[turns.length - 1]
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
