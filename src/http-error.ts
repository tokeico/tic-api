// One error type for every route. index.ts turns it into
// `{ error: { code, message } }` with the right status (contracts.ApiError).

export type ErrorStatus = 400 | 403 | 404 | 409 | 422 | 502 | 503;

export class ApiError extends Error {
  constructor(
    public status: ErrorStatus,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what = "Payout") => new ApiError(404, "not_found", `${what} not found`);
