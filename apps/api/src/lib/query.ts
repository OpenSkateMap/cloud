import { z } from "@hono/zod-openapi";

// Exponents are allowed because clients print small doubles that way (Swift: -1e-05).
const DECIMAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const INTEGER = /^-?\d+$/;

export function queryNumber({ min, max, integer = false }: { min: number; max: number; integer?: boolean }) {
  const range = z.number().min(min).max(max);
  return z
    .string()
    .regex(integer ? INTEGER : DECIMAL)
    .transform(Number)
    .pipe(integer ? range.int() : range)
    .openapi({ type: integer ? "integer" : "number", minimum: min, maximum: max });
}
