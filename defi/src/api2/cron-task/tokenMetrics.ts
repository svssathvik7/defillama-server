/**
 * Cron task: builds a consolidated token market metrics cache file.
 * Stored at the route "tokenMetrics" via storeRouteData.
 *
 * Pulls together price, market cap, FDV, 24h volume, and approximate
 * DEX liquidity for every protocol/parent-protocol that has a gecko_id.
 */

import { storeRouteData } from "../cache/file-cache";
import protocols from "../../protocols/data";
import parentProtocols from "../../protocols/parentProtocols";
import type { Protocol } from "../../protocols/types";
import type { IParentProtocol } from "../../protocols/types";

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

/** Generic JSON GET helper. */
async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Generic JSON POST helper. */
async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ─── API shapes ─────────────────────────────────────────────────────────────

interface PriceEntry {
  price?: number;
  symbol?: string;
  timestamp?: number;
  confidence?: number;
}

interface McapEntry {
  mcap?: number;
  timestamp?: number;
}

interface FdvEntry {
  fdv?: number;
  timestamp?: number;
}

interface VolumeEntry {
  volume?: number;
  timestamp?: number;
}

type PricesResponse = { coins: Record<string, PriceEntry> };
type McapsResponse  = Record<string, McapEntry>;
type FdvsResponse   = Record<string, FdvEntry>;
type VolumesResponse = Record<string, VolumeEntry>;

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
  liquidity?: number;
}

// ─── main ───────────────────────────────────────────────────────────────────

export async function storeTokenMetrics(): Promise<void> {
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

  // 2. Prices — GET, coin keys in URL, batch by 100
  const pricesMap: Record<string, PriceEntry> = {};
  const priceChunks = chunkArray(coinKeys, 100);
  for (const chunk of priceChunks) {
    try {
      const url = `https://coins.llama.fi/prices/current/${chunk.join(",")}`;
      const data: PricesResponse = await fetchJson(url);
      Object.assign(pricesMap, data?.coins ?? {});
    } catch (e) {
      console.error("[tokenMetrics] prices fetch failed for a chunk:", e);
    }
  }

  // 3. Mcaps / FDVs / coinVolumes — POST, batch by 500
  const mcapsMap: McapsResponse = {};
  const fdvsMap: FdvsResponse = {};
  const volumesMap: VolumesResponse = {};

  const postChunks = chunkArray(coinKeys, 500);

  await Promise.all(
    postChunks.map(async (chunk) => {
      const body = { coins: chunk };

      await Promise.all([
        (async () => {
          try {
            const data: McapsResponse = await postJson("https://coins.llama.fi/mcaps", body);
            Object.assign(mcapsMap, data ?? {});
          } catch (e) {
            console.error("[tokenMetrics] mcaps fetch failed for a chunk:", e);
          }
        })(),
        (async () => {
          try {
            const data: FdvsResponse = await postJson("https://coins.llama.fi/fdvs", body);
            Object.assign(fdvsMap, data ?? {});
          } catch (e) {
            console.error("[tokenMetrics] fdvs fetch failed for a chunk:", e);
          }
        })(),
        (async () => {
          try {
            const data: VolumesResponse = await postJson("https://coins.llama.fi/coinVolumes", body);
            Object.assign(volumesMap, data ?? {});
          } catch (e) {
            console.error("[tokenMetrics] coinVolumes fetch failed for a chunk:", e);
          }
        })(),
      ]);
    })
  );

  // 4. Yields pools → approximate DEX liquidity per gecko_id
  //
  // NOTE: This is an approximation (v1). Each pool's tvlUsd is split evenly
  // across its underlyingTokens addresses, but we have no reliable on-chain
  // address → gecko_id mapping at this point.  Instead we fall back to a
  // symbol-based heuristic: we build a symbol→gecko_id lookup from the
  // protocol list and match each pool's `symbol` field against it.  This
  // will overcount pools whose symbols are shared by multiple tokens (e.g.
  // "ETH"), but it is good enough as a v1 signal.
  const symbolToGeckoId = new Map<string, string>();
  for (const item of deduped) {
    if (typeof item.symbol === "string" && item.symbol.trim()) {
      const sym = item.symbol.trim().toUpperCase();
      if (!symbolToGeckoId.has(sym)) {
        symbolToGeckoId.set(sym, item.gecko_id);
      }
    }
  }

  const liquidityByGeckoId: Record<string, number> = {};

  try {
    const yieldsData: { data: Array<{ symbol: string; tvlUsd: number; underlyingTokens?: string[] }> } =
      await fetchJson("https://yields.llama.fi/pools");

    for (const pool of yieldsData?.data ?? []) {
      const { symbol, tvlUsd } = pool;
      if (!isPositiveFinite(tvlUsd)) continue;

      // Attempt symbol-based match (pool symbol may be composite like "USDC-ETH")
      const parts = typeof symbol === "string" ? symbol.toUpperCase().split(/[-/]/) : [];
      for (const part of parts) {
        const gid = symbolToGeckoId.get(part.trim());
        if (gid) {
          // Split evenly across matched parts (approximation)
          liquidityByGeckoId[gid] = (liquidityByGeckoId[gid] ?? 0) + tvlUsd / parts.length;
        }
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
      row.liquidity = liq;
    }

    rows.push(row);
  }

  // 6. Persist
  await storeRouteData("tokenMetrics", {
    data: rows,
    updatedAt: Math.floor(Date.now() / 1000),
  });

  console.log(`[tokenMetrics] Stored ${rows.length} rows.`);
}

export default storeTokenMetrics;

// Allow direct CLI execution: `ts-node tokenMetrics.ts`
if (require.main === module) {
  storeTokenMetrics()
    .catch((e) => {
      console.error("[tokenMetrics] Fatal error:", e);
      process.exit(1);
    })
    .then(() => process.exit(0));
}
