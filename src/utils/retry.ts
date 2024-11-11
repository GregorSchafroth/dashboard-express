// src/utils/retry.ts
import logger from "./logger";

export async function withRetry<T>(
  operation: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      logger.error(`Attempt ${i + 1} failed`, error);

      if (i < retries - 1) {
        await new Promise((resolve) => 
          setTimeout(resolve, delay * Math.pow(2, i))
        );
      }
    }
  }

  throw lastError;
}
