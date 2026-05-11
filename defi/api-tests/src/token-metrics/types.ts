import { z } from 'zod';
import {
  tokenMetricsItemSchema,
  tokenMetricsResponseSchema,
} from './schemas';

// Inferred types
export type TokenMetricsItem = z.infer<typeof tokenMetricsItemSchema>;
export type TokenMetricsResponse = z.infer<typeof tokenMetricsResponseSchema>;

// Type guards
export function isTokenMetricsResponse(data: any): data is TokenMetricsResponse {
  return (
    data &&
    typeof data === 'object' &&
    'data' in data &&
    Array.isArray(data.data) &&
    'updatedAt' in data &&
    typeof data.updatedAt === 'number'
  );
}
