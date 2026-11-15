import { expect, test } from "bun:test";
import { toClientConfig } from "../src/connection.ts";

test("a plain URL is passed through untouched", () => {
  const url = "postgres://openskatemap:openskatemap@localhost:54330/openskatemap";
  expect(toClientConfig(url)).toEqual({ connectionString: url });
});

test("libpq's sslrootcert=system becomes verification against the runtime's CAs", () => {
  const config = toClientConfig("postgresql://u:p@db.example.com:5432/postgres?sslmode=verify-full&sslrootcert=system");
  expect(config.ssl).toEqual({ rejectUnauthorized: true });
  expect(config.connectionString).toBe("postgresql://u:p@db.example.com:5432/postgres");
});
