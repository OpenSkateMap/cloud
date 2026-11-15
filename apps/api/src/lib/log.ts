export function errorSummary(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: typeof error };
  const cause = error.cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
  return code === undefined ? { name: error.name } : { name: error.name, code };
}

export function logFailure(label: string, cause: unknown) {
  console.error(label, errorSummary(cause));
}
