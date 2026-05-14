import { batchGet } from "./shared/dynamodb";
import { coinToPK } from "./processCoin";
import { getCoingeckoLock } from "../utils/shared/coingeckoLocks";
import sleep from "../utils/shared/sleep";
import fetch from "node-fetch";
console.log("imports done");

export type CoinsResponse = {
  [coin: string]: {
    decimals?: number;
    price: number;
    timestamp: number;
    symbol: string;
    confidence?: number;
  };
};

interface CoingeckoResponse {
  [cgId: string]: {
    usd: number;
    usd_market_cap: number;
    last_updated_at: number;
    usd_24h_vol: number;
  };
}

export interface CgMarketEntry {
  id: string;
  symbol?: string;
  name?: string;
  current_price?: number;
  market_cap?: number;
  fully_diluted_valuation?: number;
  total_volume?: number;
  circulating_supply?: number;
  total_supply?: number;
  max_supply?: number | null;
  last_updated?: string;
}

export const batchGetLatest = (pks: string[]) =>
  batchGet(
    pks.map((pk) => ({
      PK: pk,
      SK: 0,
    })),
  );

export async function getBasicCoins(requestedCoins: string[]) {
  const PKTransforms = {} as { [pk: string]: string[] };
  const pks = new Set<string>();
  requestedCoins.forEach((coin) => {
    const pk = coinToPK(coin);
    if (PKTransforms[pk]) {
      if (!PKTransforms[pk].includes(coin)) PKTransforms[pk].push(coin);
    } else {
      PKTransforms[pk] = [coin];
    }
    pks.add(pk);
  });
  const coins = await batchGetLatest([...pks]);
  return { coins, PKTransforms };
}

export async function retryCoingeckoRequest(
  query: string,
  retries: number,
  log: boolean = false,
): Promise<CoingeckoResponse> {
  for (let i = 0; i < retries; i++) {
    await getCoingeckoLock();
    try {
      const fetched = await fetch(
        `https://pro-api.coingecko.com/api/v3/${query}&x_cg_pro_api_key=${process.env.CG_KEY}`,
      );
      if (log) console.log(fetched);
      const res = (await fetched.json()) as CoingeckoResponse;
      if (log) console.log(res);
      if (Object.keys(res).length == 1 && Object.keys(res)[0] == "status")
        throw new Error(`cg call failed`);
      return res;
    } catch (e) {
      if (log) console.log(e);
      if ((i + 1) % 3 === 0 && retries > 3) {
        await sleep(10e3); // 10s
      }
      continue;
    }
  }
  return {};
}

export async function fetchCgPriceData(
  coinIds: string[],
  log: boolean = false,
) {
  return await retryCoingeckoRequest(
    `simple/price?ids=${coinIds.join(
      ",",
    )}&vs_currencies=usd&include_market_cap=true&include_last_updated_at=true&include_24hr_vol=true&precision=full`,
    10,
    log,
  );
}

export async function fetchCgMarketsData(
  coinIds: string[],
  log: boolean = false,
): Promise<CgMarketEntry[]> {
  const BATCH_SIZE = 250;
  const results: CgMarketEntry[] = [];
  for (let i = 0; i < coinIds.length; i += BATCH_SIZE) {
    const batch = coinIds.slice(i, i + BATCH_SIZE);
    // retryCoingeckoRequest is typed for /simple/price (an object response);
    // /coins/markets returns an array, so we narrow with Array.isArray.
    const res = (await retryCoingeckoRequest(
      `coins/markets?vs_currency=usd&ids=${batch.join(",")}&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=false&precision=full`,
      10,
      log,
    )) as unknown;
    if (Array.isArray(res)) {
      results.push(...(res as CgMarketEntry[]));
    }
  }
  return results;
}
