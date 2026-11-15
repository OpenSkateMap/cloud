import { z } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const ErrorCodeSchema = z
  .enum([
    "auth_required",
    "forbidden",
    "not_found",
    "conflict",
    "validation_failed",
    "rate_limited",
    "unavailable",
    "internal_error",
  ])
  .openapi("ErrorCode");

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      retryable: z.boolean(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi("ErrorEnvelope");

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

interface ErrorTraits {
  readonly status: ContentfulStatusCode;
  readonly retryable: boolean;
}

export const errorTraits = {
  auth_required: { status: 401, retryable: false },
  forbidden: { status: 403, retryable: false },
  not_found: { status: 404, retryable: false },
  conflict: { status: 409, retryable: false },
  validation_failed: { status: 422, retryable: false },
  rate_limited: { status: 429, retryable: true },
  unavailable: { status: 503, retryable: true },
  internal_error: { status: 500, retryable: true },
} as const satisfies Record<ErrorCode, ErrorTraits>;

export function toErrorEnvelope(error: AppError): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: errorTraits[error.code].retryable,
      ...(error.details !== undefined && { details: error.details }),
    },
  };
}

const errorContent = { "application/json": { schema: ErrorEnvelopeSchema } };

// Not `as const`: with a readonly object @hono/zod-openapi drops these statuses from the handler's return types.
export const errorResponses = {
  401: { description: "Not signed in, or the token is no longer valid", content: errorContent },
  403: { description: "Signed in, but this account may not do this", content: errorContent },
  404: { description: "Not found", content: errorContent },
  409: { description: "The request conflicts with what already happened, such as a submission someone else decided", content: errorContent },
  422: { description: "The request did not pass validation", content: errorContent },
  429: { description: "Too many requests", content: errorContent },
  500: { description: "Unexpected failure", content: errorContent },
  503: { description: "A dependency (the database) is not answering", content: errorContent },
};
