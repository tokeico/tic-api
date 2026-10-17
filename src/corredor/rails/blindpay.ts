import { RailNotAvailableError, type RailAdapter } from "./adapter";

export const blindpayRail: RailAdapter = {
  mode: "blindpay",
  simulated: false,
  async send() {
    if (!process.env.BLINDPAY_API_KEY) {
      throw new RailNotAvailableError("blindpay", "BLINDPAY_API_KEY is not set; use RAIL_MODE=mock or provide a sandbox key");
    }
    throw new RailNotAvailableError("blindpay", "sandbox integration not implemented yet; use RAIL_MODE=mock");
  },
};
