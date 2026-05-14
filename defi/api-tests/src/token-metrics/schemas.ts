import { z } from 'zod';

// Token metrics item schema
export const tokenMetricsItemSchema = z.object({
  defillamaId: z.string(),
  name: z.string(),
  gecko_id: z.string(),
  symbol: z.string().optional(),
  price: z.number().optional(),
  mcap: z.number().optional(),
  fdv: z.number().optional(),
  volume24h: z.number().optional(),
  dexLiquidity: z.number().optional(),
});

// Token metrics response schema
export const tokenMetricsResponseSchema = z.object({
  data: z.array(tokenMetricsItemSchema),
  updatedAt: z.number(),
});
