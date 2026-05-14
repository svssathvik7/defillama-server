/**
 * Cron task: builds a consolidated token market metrics cache file.
 * Stored at the route "token-metrics" via storeRouteData, served by the
 * GET /token-metrics handler in api2/routes.
 *
 * Pulls together price, market cap, FDV, 24h volume, and approximate
 * DEX liquidity for every protocol/parent-protocol that has a gecko_id.
 */

import axios from "axios";
import { storeRouteData } from "../cache/file-cache";
import protocols from "../../protocols/data";
import parentProtocols from "../../protocols/parentProtocols";
import type { Protocol } from "../../protocols/types";
import type { IParentProtocol } from "../../protocols/types";
import {
  fetchCurrentPrices,
  fetchMcaps,
  fetchFdvs,
  fetchCoinVolumes,
} from "../../utils/coinsApi";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Split an array into chunks of at most `size` elements. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Return true only when `v` is a finite, positive number. */
function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

// ─── output row ─────────────────────────────────────────────────────────────

export interface TokenMetricsRow {
  defillamaId: string;
  name: string;
  symbol?: string;
  gecko_id: string;
  price?: number;
  mcap?: number;
  fdv?: number;
  volume24h?: number;
  /**
   * Approximate aggregate DEX TVL routed to this token via
   * yields.llama.fi pool symbols. Symbol-matched only — overcounts shared
   * symbols (e.g. multiple "USDC" tokens) and undercounts tokens whose
   * symbol doesn't appear directly in pool symbols.
   * Pools whose composite symbol contains an ambiguous token (≤ 2 chars
   * or in the common-symbol skiplist) are dropped to limit pollution.
   */
  dexLiquidity?: number;
}

// ─── main ───────────────────────────────────────────────────────────────────

export async function storeTokenMetrics(): Promise<void> {
  try {
    await _storeTokenMetrics();
  } catch (e) {
    // Match the storeRWAStats pattern: failures here are non-fatal — the
    // surrounding cron run should continue with downstream tasks.
    console.error("[tokenMetrics] failed:", e);
  }
}

async function _storeTokenMetrics(): Promise<void> {
  // 1. Collect all items (protocols + parents) that have a gecko_id
  type SourceItem = { id: string; name: string; symbol?: string | null; gecko_id: string | null };

  const allItems: SourceItem[] = [
    ...(protocols as Protocol[]),
    ...(parentProtocols as IParentProtocol[]),
  ];

  const withGeckoId = allItems.filter(
    (p): p is SourceItem & { gecko_id: string } =>
      typeof p.gecko_id === "string" && p.gecko_id.trim().length > 0
  );

  if (withGeckoId.length === 0) {
    console.warn("[tokenMetrics] No protocols with gecko_id found — aborting.");
    return;
  }

  // De-duplicate by gecko_id (prefer the first occurrence)
  const seenGeckoIds = new Set<string>();
  const deduped: (SourceItem & { gecko_id: string })[] = [];
  for (const item of withGeckoId) {
    const gid = item.gecko_id.trim().toLowerCase();
    if (!seenGeckoIds.has(gid)) {
      seenGeckoIds.add(gid);
      deduped.push({ ...item, gecko_id: gid });
    }
  }

  const coinKeys = deduped.map((p) => `coingecko:${p.gecko_id}`);

  console.log(`[tokenMetrics] Fetching metrics for ${coinKeys.length} gecko_ids`);

  // Batch by 200 — keeps the GET-fallback prices URL well under common
  // 8KB nginx defaults (200 * ~30 chars ≈ 6KB). POST endpoints handle more
  // but a single chunk size keeps the four parallel calls aligned.
  const chunks = chunkArray(coinKeys, 200);

  const pricesMap: Record<string, { price?: number; timestamp?: number }> = {};
  const mcapsMap: Record<string, { mcap?: number; timestamp?: number }> = {};
  const fdvsMap: Record<string, { fdv?: number; timestamp?: number }> = {};
  const volumesMap: Record<string, { volume?: number; timestamp?: number }> = {};

  await Promise.all(
    chunks.map(async (chunk) => {
      await Promise.all([
        fetchCurrentPrices(chunk)
          .then((r) => Object.assign(pricesMap, r?.coins ?? {}))
          .catch((e) => console.error("[tokenMetrics] prices fetch failed for chunk:", e)),
        fetchMcaps(chunk)
          .then((r) => Object.assign(mcapsMap, r ?? {}))
          .catch((e) => console.error("[tokenMetrics] mcaps fetch failed for chunk:", e)),
        fetchFdvs(chunk)
          .then((r) => Object.assign(fdvsMap, r ?? {}))
          .catch((e) => console.error("[tokenMetrics] fdvs fetch failed for chunk:", e)),
        fetchCoinVolumes(chunk)
          .then((r) => Object.assign(volumesMap, r ?? {}))
          .catch((e) => console.error("[tokenMetrics] coinVolumes fetch failed for chunk:", e)),
      ]);
    }),
  );

  // Approximate per-token DEX liquidity from yields.llama.fi pool symbols.
  //
  // This is symbol-matching only — there is no reliable address→gecko_id map
  // at this layer. It overcounts shared symbols and undercounts tokens whose
  // ticker doesn't appear in pool symbols. Mitigations: skip ambiguous short
  // tickers and well-known polysemous symbols rather than smearing TVL onto
  // every gecko_id that happens to use "BTC"/"ETH".
  const AMBIGUOUS_SYMBOLS = new Set([
    // Wrappers and short tickers that resolve to many distinct tokens across chains
    "ETH", "WETH", "BTC", "WBTC", "USDC", "USDT", "DAI", "BNB", "WBNB",
    "SOL", "WSOL", "MATIC", "AVAX", "FTM", "OP", "ARB",
  ]);
  const symbolToGeckoId = new Map<string, string>();
  for (const item of deduped) {
    if (typeof item.symbol !== "string") continue;
    const sym = item.symbol.trim().toUpperCase();
    if (sym.length < 3) continue;
    if (AMBIGUOUS_SYMBOLS.has(sym)) continue;
    if (!symbolToGeckoId.has(sym)) symbolToGeckoId.set(sym, item.gecko_id);
  }

  const liquidityByGeckoId: Record<string, number> = {};

  try {
    const yieldsRes = await axios.get<{
      data: Array<{ symbol?: string; tvlUsd?: number }>;
    }>("https://yields.llama.fi/pools");
    for (const pool of yieldsRes.data?.data ?? []) {
      if (!isPositiveFinite(pool.tvlUsd)) continue;
      if (typeof pool.symbol !== "string") continue;
      const parts = pool.symbol.toUpperCase().split(/[-/]/).map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      // Drop the pool entirely if any leg is ambiguous — better to undercount
      // than smear TVL across unrelated tokens that share a symbol.
      if (parts.some((p) => AMBIGUOUS_SYMBOLS.has(p) || p.length < 3)) continue;
      const matched = parts.map((p) => symbolToGeckoId.get(p)).filter((g): g is string => !!g);
      if (matched.length === 0) continue;
      const share = pool.tvlUsd! / parts.length;
      for (const gid of matched) {
        liquidityByGeckoId[gid] = (liquidityByGeckoId[gid] ?? 0) + share;
      }
    }
  } catch (e) {
    console.error("[tokenMetrics] yields pools fetch failed:", e);
  }

  // 5. Compose output rows
  const rows: TokenMetricsRow[] = [];

  for (const item of deduped) {
    const coinKey = `coingecko:${item.gecko_id}`;

    const row: TokenMetricsRow = {
      defillamaId: item.id,
      name: item.name,
      gecko_id: item.gecko_id,
    };

    if (typeof item.symbol === "string" && item.symbol.trim()) {
      row.symbol = item.symbol.trim();
    }

    const priceEntry = pricesMap[coinKey];
    if (isPositiveFinite(priceEntry?.price)) {
      row.price = priceEntry!.price;
    }

    const mcapEntry = mcapsMap[coinKey];
    if (isPositiveFinite(mcapEntry?.mcap)) {
      row.mcap = mcapEntry!.mcap;
    }

    const fdvEntry = fdvsMap[coinKey];
    if (isPositiveFinite(fdvEntry?.fdv)) {
      row.fdv = fdvEntry!.fdv;
    }

    const volumeEntry = volumesMap[coinKey];
    if (isPositiveFinite(volumeEntry?.volume)) {
      row.volume24h = volumeEntry!.volume;
    }

    const liq = liquidityByGeckoId[item.gecko_id];
    if (isPositiveFinite(liq)) {
      row.dexLiquidity = liq;
    }

    rows.push(row);
  }

  // 6. Persist — name matches the public route /token-metrics. The cache
  // normalizer would accept either form, but keeping them aligned avoids
  // confusion when grepping.
  await storeRouteData("token-metrics", {
    data: rows,
    updatedAt: Math.floor(Date.now() / 1000),
  });

  console.log(`[tokenMetrics] Stored ${rows.length} rows.`);
}

export default storeTokenMetrics;
