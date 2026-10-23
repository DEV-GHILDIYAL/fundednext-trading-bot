/**
 * Every Groq review is appended to data/ai-reviews.jsonl — approved AND rejected signals —
 * so `npm run ai-audit` can later check whether the vetoed trades would have won or lost.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface AiReviewRecord {
  at: string;
  sleeve: string;
  pair: string;
  side: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number;
  verdict: 'approved' | 'rejected' | 'unavailable';
  aiDecision?: string;
  confidence?: number;
  reasoning?: string;
  /** true when the signal was actually traded */
  traded: boolean;
}

export function aiReviewLogPath(): string {
  return path.join(config.dataDir, 'ai-reviews.jsonl');
}

export function logAiReview(record: AiReviewRecord): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(aiReviewLogPath(), JSON.stringify(record) + '\n');
  } catch (error) {
    logger.warn(`Could not write AI review log: ${(error as Error).message}`);
  }
}

export function readAiReviews(file: string = aiReviewLogPath()): AiReviewRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as AiReviewRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is AiReviewRecord => r !== null);
}
