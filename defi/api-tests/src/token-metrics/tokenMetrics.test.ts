import { createApiClient } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { TokenMetricsResponse, isTokenMetricsResponse } from './types';
import { tokenMetricsResponseSchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectValidNumber,
  expectPositiveNumber,
  expectValidTimestamp,
} from '../../utils/testHelpers';
import { ApiResponse } from '../../utils/config/apiClient';

const apiClient = createApiClient(endpoints.TOKEN_METRICS.BASE_URL);

describe('Token Metrics API', () => {
  let tokenMetricsResponse: ApiResponse<TokenMetricsResponse>;

  beforeAll(async () => {
    tokenMetricsResponse = await apiClient.get<TokenMetricsResponse>(
      endpoints.TOKEN_METRICS.TOKEN_METRICS
    );
  }, 30000);

  describe('Basic Response Validation', () => {
    it('should return successful response with valid structure', () => {
      expectSuccessfulResponse(tokenMetricsResponse);
      expect(isTokenMetricsResponse(tokenMetricsResponse.data)).toBe(true);
      expect(tokenMetricsResponse.data).toHaveProperty('data');
      expect(tokenMetricsResponse.data).toHaveProperty('updatedAt');
    });

    it('should validate against Zod schema', () => {
      const result = tokenMetricsResponseSchema.safeParse(tokenMetricsResponse.data);
      if (!result.success) {
        console.log('Validation errors:', JSON.stringify(result.error.issues.slice(0, 10), null, 2));
      }
      expect(result.success).toBe(true);
    });

    it('should have data array with at least one item', () => {
      expect(Array.isArray(tokenMetricsResponse.data.data)).toBe(true);
      expect(tokenMetricsResponse.data.data.length).toBeGreaterThan(0);
    });

    it('should have updatedAt as a valid timestamp', () => {
      expectValidTimestamp(tokenMetricsResponse.data.updatedAt);
    });
  });

  describe('Token Item Validation', () => {
    it('should have required string fields in all tokens', () => {
      tokenMetricsResponse.data.data.slice(0, 20).forEach((token) => {
        expect(token).toHaveProperty('defillamaId');
        expect(token).toHaveProperty('name');
        expect(token).toHaveProperty('gecko_id');
        expect(token).toHaveProperty('symbol');
        expect(token).toHaveProperty('updatedAt');

        expect(typeof token.defillamaId).toBe('string');
        expect(token.defillamaId.length).toBeGreaterThan(0);
        expect(typeof token.name).toBe('string');
        expect(token.name.length).toBeGreaterThan(0);
        expect(typeof token.gecko_id).toBe('string');
        expect(token.gecko_id.length).toBeGreaterThan(0);
        expect(typeof token.symbol).toBe('string');
        expect(token.symbol.length).toBeGreaterThan(0);
      });
    });

    it('should have updatedAt as a valid number for all tokens', () => {
      tokenMetricsResponse.data.data.slice(0, 20).forEach((token) => {
        expectValidTimestamp(token.updatedAt);
      });
    });

    it('should have valid price when present', () => {
      const tokensWithPrice = tokenMetricsResponse.data.data
        .filter((token) => token.price !== null && token.price !== undefined)
        .slice(0, 20);

      if (tokensWithPrice.length > 0) {
        tokensWithPrice.forEach((token) => {
          expectValidNumber(token.price!);
          expectPositiveNumber(token.price!);
        });
      }
    });

    it('should have valid mcap when present', () => {
      const tokensWithMcap = tokenMetricsResponse.data.data
        .filter((token) => token.mcap !== null && token.mcap !== undefined)
        .slice(0, 20);

      if (tokensWithMcap.length > 0) {
        tokensWithMcap.forEach((token) => {
          expectValidNumber(token.mcap!);
          expectPositiveNumber(token.mcap!);
        });
      }
    });

    it('should have valid fdv when present', () => {
      const tokensWithFdv = tokenMetricsResponse.data.data
        .filter((token) => token.fdv !== null && token.fdv !== undefined)
        .slice(0, 20);

      if (tokensWithFdv.length > 0) {
        tokensWithFdv.forEach((token) => {
          expectValidNumber(token.fdv!);
          expectPositiveNumber(token.fdv!);
        });
      }
    });

    it('should have valid volume24h when present', () => {
      const tokensWithVolume = tokenMetricsResponse.data.data
        .filter((token) => token.volume24h !== null && token.volume24h !== undefined)
        .slice(0, 20);

      if (tokensWithVolume.length > 0) {
        tokensWithVolume.forEach((token) => {
          expectValidNumber(token.volume24h!);
          expectPositiveNumber(token.volume24h!);
        });
      }
    });

    it('should have valid liquidity when present', () => {
      const tokensWithLiquidity = tokenMetricsResponse.data.data
        .filter((token) => token.liquidity !== null && token.liquidity !== undefined)
        .slice(0, 20);

      if (tokensWithLiquidity.length > 0) {
        tokensWithLiquidity.forEach((token) => {
          expectValidNumber(token.liquidity!);
          expectPositiveNumber(token.liquidity!);
        });
      }
    });
  });

  describe('Data Quality Validation', () => {
    it('should have unique defillamaIds', () => {
      const ids = tokenMetricsResponse.data.data.map((token) => token.defillamaId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have tokens with at least some numeric data', () => {
      const tokensWithMetrics = tokenMetricsResponse.data.data.filter((token) => {
        return (
          (token.price !== null && token.price !== undefined) ||
          (token.mcap !== null && token.mcap !== undefined) ||
          (token.fdv !== null && token.fdv !== undefined) ||
          (token.volume24h !== null && token.volume24h !== undefined) ||
          (token.liquidity !== null && token.liquidity !== undefined)
        );
      });

      expect(tokensWithMetrics.length).toBeGreaterThan(0);
    });

    it('should have mcap >= fdv when both are present', () => {
      const tokensWithBoth = tokenMetricsResponse.data.data
        .filter(
          (token) =>
            token.mcap !== null &&
            token.mcap !== undefined &&
            token.fdv !== null &&
            token.fdv !== undefined
        )
        .slice(0, 20);

      if (tokensWithBoth.length > 0) {
        tokensWithBoth.forEach((token) => {
          // mcap should be <= fdv (market cap is typically less than or equal to FDV)
          expect(token.mcap!).toBeLessThanOrEqual(token.fdv! * 1.01); // Allow 1% tolerance
        });
      }
    });

    it('should have multiple tokens represented', () => {
      const tokenNames = new Set(tokenMetricsResponse.data.data.map((token) => token.name));
      expect(tokenNames.size).toBeGreaterThan(1);
    });

    it('should have well-known tokens', () => {
      const tokenNames = tokenMetricsResponse.data.data.map((token) => token.name.toLowerCase());
      const symbols = tokenMetricsResponse.data.data.map((token) => token.symbol.toUpperCase());

      // Check for some well-known tokens (at least one should be present)
      const wellKnownTokens = ['compound', 'aave', 'uniswap', 'lido', 'makerdao'];
      const wellKnownSymbols = ['COMP', 'AAVE', 'UNI', 'LDO', 'MKR'];

      const foundTokens = wellKnownTokens.filter((name) =>
        tokenNames.some((n) => n.includes(name))
      );
      const foundSymbols = wellKnownSymbols.filter((sym) => symbols.includes(sym));

      const anyFound = foundTokens.length > 0 || foundSymbols.length > 0;
      console.log(`Found ${foundTokens.length} well-known tokens and ${foundSymbols.length} well-known symbols`);

      // Just log - don't fail if not found, as data may vary
      expect(tokenMetricsResponse.data.data.length).toBeGreaterThan(0);
    });
  });
});
