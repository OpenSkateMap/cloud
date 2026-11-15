import type { Err, Result } from "neverthrow";

export { err, errAsync, ok, okAsync, Result, ResultAsync, safeTry } from "neverthrow";

/** A `safeTry` body: `yield*` a result to go on with its value, or to stop with its error. */
export type Attempt<T, E> = AsyncGenerator<Err<never, E>, Result<T, E>>;
