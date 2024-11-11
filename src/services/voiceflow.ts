// src/services/voiceflow.ts
import axios from 'axios'
import { logger } from '../utils/logger.js'

export type VoiceflowTranscript = {
  _id: string
  name?: string
  image?: string
  creatorID?: string
  unread?: boolean
  reportTags?: string[]
  createdAt: string
}

export async function getTranscripts(
  voiceflowProjectId: string,
  apiKey: string
): Promise<VoiceflowTranscript[]> {
  logger.api('Fetching transcripts', { voiceflowProjectId })

  // Get dates for the range (since yesterday '-1'/ 1 week ago '-7')
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - 7)
  startDate.setHours(0, 0, 0, 0)

  const endDate = new Date()
  endDate.setDate(endDate.getDate() + 1)
  endDate.setHours(23, 59, 59, 999)

  const formatDate = (date: Date) => {
    return date.toISOString().split('T')[0]
  }

  const url = `https://api.voiceflow.com/v2/transcripts/${voiceflowProjectId}`
  // const url = `https://api.voiceflow.com/v2/transcripts/${voiceflowProjectId}?startDate=${formatDate(
  //   startDate
  // )}&endDate=${formatDate(endDate)}`

  try {
    logger.api('Attempting Voiceflow API request', { url })

    const response = await axios.get(url, {
      headers: {
        accept: 'application/json',
        Authorization: apiKey,
        'Cache-Control': 'no-cache',
      },
    })

    if (!Array.isArray(response.data)) {
      logger.error('Invalid response format', { data: response.data })
      throw new Error('Invalid response format from Voiceflow API')
    }

    logger.api('Voiceflow API response received', {
      count: response.data.length,
    })

    return response.data
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logger.error('Voiceflow API error', {
        status: error.response?.status,
        data: error.response?.data,
        url,
      })
    } else {
      logger.error('Error fetching transcripts', error)
    }
    throw error
  }
}
