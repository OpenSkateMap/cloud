/** A CHECK's `in (...)` list from a schema's own constants (never user input). */
export const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
