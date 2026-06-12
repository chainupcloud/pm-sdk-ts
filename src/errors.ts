/** SDK error hierarchy. */

export class PredictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Client-side input validation failure (bad price, missing field, ...). */
export class ValidationError extends PredictError {}

/** Signing failure (bad private key, missing exchange address, ...). */
export class SignerError extends PredictError {}

/** Transport-level failure (network error, timeout). */
export class TransportError extends PredictError {}

/** Non-2xx HTTP response from the API. */
export class ApiError extends PredictError {
  readonly status: number;
  readonly body: string;
  readonly path: string;

  constructor(status: number, path: string, body: string) {
    super(`HTTP ${status} on ${path}: ${truncate(body, 500)}`);
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/** 429 from the API. */
export class RateLimitError extends ApiError {}

/** Relayer transaction reached a terminal failure state (FAILED / DROPPED / INVALID). */
export class RelayerTxError extends PredictError {
  readonly transactionId: string;
  readonly state: string;

  constructor(transactionId: string, state: string, detail?: string) {
    super(`relayer transaction ${transactionId} ended in ${state}${detail ? `: ${detail}` : ""}`);
    this.transactionId = transactionId;
    this.state = state;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
