import { describe, expect, it } from "vitest";
import { normalizeFeedResponse, type DecodedFeedResponse } from "./normalize";

const RECV_TS = 1_782_877_800_000;

describe("normalizeFeedResponse (SPEC §3, §12.5)", () => {
  it("returns no ticks for market_info frames", () => {
    const res: DecodedFeedResponse = {
      type: "market_info",
      marketInfo: { segmentStatus: { NSE_FO: "NORMAL_OPEN" } },
    };
    expect(normalizeFeedResponse(res, RECV_TS)).toEqual([]);
  });

  it("normalizes a full-mode option feed (marketFF)", () => {
    const res: DecodedFeedResponse = {
      type: "live_feed",
      feeds: {
        "SYNTH_FO|SAMPLE_CE": {
          fullFeed: {
            marketFF: {
              ltpc: { ltp: 104.85, ltt: 1_782_877_801_000, ltq: 75 },
              marketLevel: {
                bidAskQuote: [
                  { bidQ: 900, bidP: 104.7, askQ: 850, askP: 105.0 },
                  { bidQ: 1200, bidP: 104.65, askQ: 700, askP: 105.05 },
                ],
              },
              optionGreeks: { iv: 14.2, delta: 0.52, theta: -3.1, vega: 9.8 },
              vtt: 123_450,
              oi: 501_200,
            },
          },
        },
      },
    };
    const [tick] = normalizeFeedResponse(res, RECV_TS);
    expect(tick).toMatchObject({
      instrumentKey: "SYNTH_FO|SAMPLE_CE",
      ts: 1_782_877_801_000,
      ltp: 104.85,
      ltq: 75,
      volume: 123_450,
      oi: 501_200,
      bidPrice: 104.7,
      bidQty: 900,
      askPrice: 105.0,
      askQty: 850,
      iv: 14.2,
      delta: 0.52,
    });
    expect(tick?.depth?.bids).toHaveLength(2);
    expect(tick?.depth?.asks).toHaveLength(2);
  });

  it("normalizes an index feed (indexFF) without volume/oi/depth", () => {
    const res: DecodedFeedResponse = {
      feeds: {
        "SYNTH_INDEX|Sample 50": {
          fullFeed: { indexFF: { ltpc: { ltp: 24_812.4, ltt: 1_782_877_802_000 } } },
        },
      },
    };
    const [tick] = normalizeFeedResponse(res, RECV_TS);
    expect(tick).toMatchObject({ ltp: 24_812.4, ts: 1_782_877_802_000 });
    expect(tick?.volume).toBeUndefined();
    expect(tick?.depth).toBeUndefined();
  });

  it("normalizes ltpc-mode feeds and falls back to receive time without ltt", () => {
    const res: DecodedFeedResponse = {
      feeds: { "SYNTH_FO|SAMPLE_PE": { ltpc: { ltp: 88.4 } } },
    };
    const [tick] = normalizeFeedResponse(res, RECV_TS);
    expect(tick).toMatchObject({ ltp: 88.4, ts: RECV_TS });
  });

  it("coerces protobuf Long values decoded as strings", () => {
    const res: DecodedFeedResponse = {
      feeds: {
        "SYNTH_FO|SAMPLE_CE": {
          fullFeed: {
            marketFF: {
              ltpc: { ltp: "104.85", ltt: "1782877801000" },
              vtt: "123450",
              oi: "501200",
            },
          },
        },
      },
    };
    const [tick] = normalizeFeedResponse(res, RECV_TS);
    expect(tick).toMatchObject({
      ltp: 104.85,
      ts: 1_782_877_801_000,
      volume: 123_450,
      oi: 501_200,
    });
  });

  it("skips feed entries without a usable ltp", () => {
    const res: DecodedFeedResponse = {
      feeds: { "SYNTH_FO|EMPTY": { fullFeed: { marketFF: {} } } },
    };
    expect(normalizeFeedResponse(res, RECV_TS)).toEqual([]);
  });

  it("caps depth at 5 levels", () => {
    const quote = { bidQ: 10, bidP: 1, askQ: 10, askP: 2 };
    const res: DecodedFeedResponse = {
      feeds: {
        "SYNTH_FO|SAMPLE_CE": {
          fullFeed: {
            marketFF: {
              ltpc: { ltp: 1.5 },
              marketLevel: { bidAskQuote: Array(8).fill(quote) },
            },
          },
        },
      },
    };
    const [tick] = normalizeFeedResponse(res, RECV_TS);
    expect(tick?.depth?.bids).toHaveLength(5);
  });
});
