import { Data } from "effect";

/**
 * The API answered with an error. `code` is the API's machine-readable code
 * (for example `NOT_FOUND`, `FORBIDDEN`, `TOO_MANY_REQUESTS`), `status` the
 * HTTP status.
 */
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly operation: string;
  /** Seconds to wait before retrying, when the API says so. */
  readonly retryAfter?: number;
}> {}

/** No API key, no workspace, or a setting that can't work. */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
}> {}

/** The request never got an answer: DNS, TLS, connection reset, offline. */
export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
  readonly operation: string;
  readonly cause?: unknown;
}> {}

/** The API answered, but not in a shape this SDK understands. */
export class ResponseError extends Data.TaggedError("ResponseError")<{
  readonly message: string;
  readonly operation: string;
}> {}

/** A backup or restore finished, and it failed or was cancelled. */
export class OperationFailed extends Data.TaggedError("OperationFailed")<{
  readonly kind: "backup" | "restore";
  readonly id: string;
  readonly status: string;
  readonly message: string;
}> {}

/** Waiting for a backup or restore took longer than allowed. */
export class WaitTimeout extends Data.TaggedError("WaitTimeout")<{
  readonly kind: "backup" | "restore";
  readonly id: string;
  readonly message: string;
}> {}

/** Decrypting or decompressing a backup on this machine failed. */
export class LocalError extends Data.TaggedError("LocalError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type BackupdError =
  | ApiError
  | ConfigError
  | NetworkError
  | ResponseError
  | OperationFailed
  | WaitTimeout
  | LocalError;

/** True for API errors that mean the key is missing, wrong or revoked. */
export const isAuthError = (error: BackupdError): boolean =>
  error._tag === "ApiError" && error.status === 401;
