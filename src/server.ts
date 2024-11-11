// src/server.ts
import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from 'express'
import dotenv from 'dotenv'
import { processWebhook } from './webhook/processWebhook.js'
import logger from './utils/logger.js'
import type { WebhookBody } from './types/voiceflow.js'

// Load environment variables
dotenv.config()

const app = express()
const port = process.env.PORT || 5000

// Middleware to parse JSON bodies
app.use(express.json())

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

// Voiceflow webhook endpoint
const webhookHandler: RequestHandler = async (req, res) => {
  const startTime = Date.now()
  logger.sectionStart('Webhook Request')

  try {
    const body = req.body as WebhookBody
    logger.api('Webhook payload received', body)

    // Start background processing
    processWebhook(body).catch((error) => {
      logger.error('Background processing failed', error)
    })

    logger.progress('Webhook acknowledged, processing started')
    logger.sectionEnd('Webhook Request', startTime)

    res.json({
      success: true,
      message: 'Webhook received, processing in background',
    })
  } catch (error) {
    logger.error('Webhook handler failed', error)
    res.status(500).json({ error: 'Error processing webhook' })
  }
}

app.post('/webhook/voiceflow', webhookHandler)

// Error handling middleware
const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error('Unhandled error', err)
  res.status(500).json({ error: 'Internal server error' })
}

app.use(errorHandler)

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled Rejection', reason)
})

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception', error)
  // Give the server 5 seconds to finish processing existing requests
  setTimeout(() => process.exit(1), 10000)
})
