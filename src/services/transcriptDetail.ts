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

        // Enhanced sorting logic to match saveTranscriptTurns
        const enhancedTurns = response.data.map((turn, index) => ({
          ...turn,
          sequence: index,
        }))

        const sortedTurns = enhancedTurns.sort((a, b) => {
          const timeA = new Date(a.startTime).getTime()
          const timeB = new Date(b.startTime).getTime()
          if (timeA !== timeB) return timeA - timeB
          if (a.type === 'request' && b.type === 'text') return -1
          if (a.type === 'text' && b.type === 'request') return 1
          return a.sequence - b.sequence
        })

        logger.prisma('Fetched transcript content', {
          transcriptId,
          turnsCount: sortedTurns.length,
        })

        // Remove the sequence before returning
        return sortedTurns.map(({ sequence, ...turn }) => turn)
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
  // Sort and enhance turns with sequence numbers
  const enhancedTurns = turns.map((turn, index) => ({
    ...turn,
    sequence: index,
  }))

  const sortedTurns = enhancedTurns.sort((a, b) => {
    const timeA = new Date(a.startTime).getTime()
    const timeB = new Date(b.startTime).getTime()
    if (timeA !== timeB) return timeA - timeB
    if (a.type === 'request' && b.type === 'text') return -1
    if (a.type === 'text' && b.type === 'request') return 1
    return a.sequence - b.sequence
  })

  const metrics = calculateTranscriptMetrics(sortedTurns)

  try {
    const analysis = await analyzeTranscript(sortedTurns)

    await prisma.$transaction(async (tx) => {
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

      await tx.turn.deleteMany({
        where: { transcriptId },
      })

      await tx.turn.createMany({
        data: sortedTurns.map((turn) => ({
          transcriptId,
          type: turn.type,
          payload: turn.payload as Prisma.InputJsonValue,
          startTime: new Date(turn.startTime),
          format: turn.format,
          voiceflowTurnId: turn.turnID,
          sequence: turn.sequence ?? 0,
        })),
      })
    })

    logger.prisma('Saved transcript with sequences', {
      transcriptId,
      turnCount: turns.length,
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
