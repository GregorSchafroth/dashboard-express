// src/utils/logger.ts
export const logger = {
  sectionStart: (section: string) => console.log(`\n=== Starting ${section} ===`),
  sectionEnd: (section: string, startTime: number) => 
    console.log(`=== ${section} completed in ${Date.now() - startTime}ms ===\n`),
  api: (message: string, data?: unknown) => console.log('API:', message, data),
  error: (message: string, error: unknown) => console.error('ERROR:', message, error),
  progress: (message: string) => console.log('Progress:', message),
  prisma: (message: string, data?: unknown) => console.log('Database:', message, data)
};

export default logger