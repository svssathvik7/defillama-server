import { successResponse, wrap, IResponse } from "./utils/shared";
import ddb from "./utils/shared/dynamodb";
import parseRequestBody from "./utils/shared/parseRequestBody";
import { getBasicCoins } from "./utils/getCoinsUtils";

type FdvsResponse = {
  [coin: string]: {
    fdv: number;
    timestamp: number;
  };
};

const handler = async (
  event: AWSLambda.APIGatewayEvent,
): Promise<IResponse> => {
  const body = parseRequestBody(event.body);
  const requestedCoins = body.coins;
  const {PKTransforms, coins} = await getBasicCoins(requestedCoins)
  const response = {} as FdvsResponse;
  await Promise.all(
    coins.map(async (coin) => {
      const formattedCoin = {
        fdv: coin.fdv,
        timestamp: coin.timestamp,
      };
      if (coin.redirect) {
        const redirectedCoin = await ddb.get({
          PK: coin.redirect,
          SK: 0,
        });
        if (redirectedCoin.Item === undefined) {
          return;
        }
        if (redirectedCoin.Item?.fdv)
          formattedCoin.fdv = redirectedCoin.Item?.fdv;
        formattedCoin.timestamp = redirectedCoin.Item?.timestamp;
      }
      PKTransforms[coin.PK].forEach((coinName) => {
        response[coinName] = formattedCoin;
      });
    }),
  );
  return successResponse(response);
};

export default wrap(handler);
