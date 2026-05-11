import { z } from 'zod';

// Token metrics item schema
export const tokenMetricsItemSchema = z.object({
  defillamaId: z.string(),
  name: z.string(),
  gecko_id: z.string(),
  symbol: z.string(),
  price: z.number().optional(),
  mcap: z.number().optional(),
  fdv: z.number().optional(),
  volume24h: z.number().optional(),
  liquidity: z.number().optional(),
  updatedAt: z.number(),
});

// Token metrics response schema
export const tokenMetricsResponseSchema = z.object({
  data: z.array(tokenMetricsItemSchema),
  updatedAt: z.number(),
});
