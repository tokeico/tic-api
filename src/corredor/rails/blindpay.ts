import type { RailAdapter } from "./adapter";

export const blindpayRail: RailAdapter = {
  mode: "blindpay",
  send() {
    if (!process.env.BLINDPAY_API_KEY) {
      return Promise.reject(
        new Error(
          "BLINDPAY_API_KEY is not set. Refusing to pay through BlindPay. Set RAIL_MODE=mock or provide a sandbox key.",
        ),
      );
    }
    return Promise.reject(
      new Error("BlindPay sandbox client is not implemented. Set RAIL_MODE=mock."),
    );
  },
};
