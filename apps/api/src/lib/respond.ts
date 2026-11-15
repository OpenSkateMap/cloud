import type { Context } from "hono";
import { success } from "./envelope.ts";
import { type AppError, type ErrorCode, errorTraits, toErrorEnvelope } from "./errors.ts";
import type { Result } from "./result.ts";

export function respondError<C extends ErrorCode>(c: Context, error: AppError & { readonly code: C }) {
  const status: (typeof errorTraits)[C]["status"] = errorTraits[error.code].status;
  const wait = error.details?.retry_after_seconds;
  if (typeof wait === "number") c.header("Retry-After", String(Math.ceil(wait)));
  if (status === 401) c.header("WWW-Authenticate", 'Bearer realm="openskatemap"');
  return c.json(toErrorEnvelope(error), status);
}

/** A service's answer as the response: its value in the success envelope, or its error. */
export function reply<T>(c: Context, result: Result<T, AppError>) {
  return result.isErr() ? respondError(c, result.error) : c.json(success(result.value), 200);
}
