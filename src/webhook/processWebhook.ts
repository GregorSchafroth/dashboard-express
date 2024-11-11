// src/webhook/processWebhook.ts
import logger from '../utils/logger.js'
import prisma from '../lib/prisma.js'
import { getTranscripts } from '../services/voiceflow.js'
import {
  getTranscriptContent,
  saveTranscriptTurns,
} from '../services/transcriptDetail.js'
import type { VoiceflowTranscript } from '../services/voiceflow.js'
import pLimit from 'p-limit'

type TranscriptWithNumber = VoiceflowTranscript & {
  assignedNumber: number
}

async function preassignTranscriptNumbers(
  projectId: number,
  transcripts: VoiceflowTranscript[]
): Promise<TranscriptWithNumber[]> {
  // Get the current last transcript number
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { lastTranscriptNumber: true },
  })

  if (!project) {
    throw new Error(`Project not found with ID: ${projectId}`)
  }

  let nextNumber = project.lastTranscriptNumber + 1

  // Pre-assign numbers to all new transcripts
  const existingTranscripts = await prisma.transcript.findMany({
    where: {
      projectId,
      voiceflowTranscriptId: {
        in: transcripts.map((t) => t._id),
      },
    },
    select: {
      voiceflowTranscriptId: true,
      transcriptNumber: true,
    },
  })

  const existingTranscriptMap = new Map(
    existingTranscripts.map((t) => [
      t.voiceflowTranscriptId,
      t.transcriptNumber,
    ])
  )

  // Update project's last transcript number in a single transaction
  const newTranscriptsCount = transcripts.filter(
    (t) => !existingTranscriptMap.has(t._id)
  ).length

  if (newTranscriptsCount > 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        lastTranscriptNumber: {
          increment: newTranscriptsCount,
        },
      },
    })
  }

  // Assign numbers to transcripts
  return transcripts.map((transcript) => ({
    ...transcript,
    assignedNumber: existingTranscriptMap.get(transcript._id) || nextNumber++,
  }))
}

async function processAndSaveTranscripts(
  voiceflowProjectId: string,
  transcripts: VoiceflowTranscript[],
  apiKey: string
) {
  logger.sectionStart('Transcript Processing')
  const startTime = Date.now()

  if (!Array.isArray(transcripts)) {
    logger.error('Invalid transcripts data', transcripts)
    throw new Error('Transcripts data must be an array')
  }

  const sortedTranscripts = [...transcripts].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )

  const project = await prisma.project.findFirst({
    where: { voiceflowProjectId },
    select: { id: true, lastTranscriptNumber: true },
  })

  if (!project) {
    logger.error('Project not found', { voiceflowProjectId })
    throw new Error(
      `No project found with Voiceflow Project ID: ${voiceflowProjectId}`
    )
  }

  // Pre-assign transcript numbers
  const transcriptsWithNumbers = await preassignTranscriptNumbers(
    project.id,
    sortedTranscripts
  )

  // Configure concurrency limits
  const BATCH_SIZE = 10
  const RATE_LIMIT = pLimit(5)
  const MIN_DELAY = 200
  const MAX_RETRIES = 3

  // Process transcripts in batches
  for (let i = 0; i < transcriptsWithNumbers.length; i += BATCH_SIZE) {
    const batch = transcriptsWithNumbers.slice(i, i + BATCH_SIZE)
    logger.progress(
      `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
        transcriptsWithNumbers.length / BATCH_SIZE
      )} (${i + 1}-${Math.min(
        i + BATCH_SIZE,
        transcriptsWithNumbers.length
      )} of ${transcriptsWithNumbers.length})`
    )

    const batchPromises = batch.map((transcript) =>
      RATE_LIMIT(async () => {
        const transcriptStart = Date.now()
        let retryCount = 0

        while (retryCount < MAX_RETRIES) {
          try {
            // Create or update transcript with pre-assigned number
            const savedTranscript = await prisma.transcript.upsert({
              where: {
                projectId_voiceflowTranscriptId: {
                  projectId: project.id,
                  voiceflowTranscriptId: transcript._id || '',
                },
              },
              update: {
                name: transcript.name || 'Untitled',
                image: transcript.image ?? null,
                reportTags: Array.isArray(transcript.reportTags)
                  ? transcript.reportTags
                  : [],
                metadata: {
                  creatorID: transcript.creatorID || null,
                  unread: transcript.unread || false,
                },
                updatedAt: new Date(),
              },
              create: {
                transcriptNumber: transcript.assignedNumber,
                projectId: project.id,
                voiceflowTranscriptId: transcript._id || '',
                name: transcript.name || 'Untitled',
                image: transcript.image ?? null,
                reportTags: Array.isArray(transcript.reportTags)
                  ? transcript.reportTags
                  : [],
                metadata: {
                  creatorID: transcript.creatorID || null,
                  unread: transcript.unread || false,
                },
                createdAt: new Date(transcript.createdAt),
                updatedAt: new Date(),
              },
            })

            const turns = await getTranscriptContent(
              transcript._id,
              voiceflowProjectId,
              apiKey
            )

            await saveTranscriptTurns(savedTranscript.id, turns)

            logger.prisma('Processing completed', {
              transcriptId: transcript._id,
              transcriptNumber: transcript.assignedNumber,
              duration: Date.now() - transcriptStart,
            })

            const delay = MIN_DELAY + Math.random() * 300
            await new Promise((resolve) => setTimeout(resolve, delay))

            break
          } catch (error) {
            retryCount++
            logger.error(
              `Failed to process transcript ${transcript._id} (attempt ${retryCount}/${MAX_RETRIES})`,
              error
            )

            if (retryCount === MAX_RETRIES) {
              throw error
            }

            const backoffDelay = Math.pow(2, retryCount) * 1000
            await new Promise((resolve) => setTimeout(resolve, backoffDelay))
          }
        }
      })
    )

    await Promise.allSettled(batchPromises)
  }

  logger.sectionEnd('Transcript Processing', startTime)
}

export async function processWebhook(body: {
  voiceflowProjectId: string
}): Promise<void> {
  const startTime = Date.now()
  try {
    logger.sectionStart('Processing Webhook')

    const voiceflowProjectId = body.voiceflowProjectId
    if (!voiceflowProjectId) {
      throw new Error('Missing voiceflowProjectId in webhook body')
    }

    const project = await prisma.project.findFirst({
      where: { voiceflowProjectId },
      select: { voiceflowApiKey: true },
    })

    if (!project) {
      throw new Error(
        `No project found with Voiceflow Project ID: ${voiceflowProjectId}`
      )
    }

    const apiKey = project.voiceflowApiKey
    logger.prisma('Retrieved API key for project', { voiceflowProjectId })

    const transcripts = await getTranscripts(voiceflowProjectId, apiKey)
    logger.api('Received transcripts list', { count: transcripts.length })

    await processAndSaveTranscripts(voiceflowProjectId, transcripts, apiKey)

    logger.sectionEnd('Processing Webhook', startTime)
  } catch (error) {
    logger.error('Error processing webhook', error)
    throw error
  }
}
