/** Under `bun test --parallel`, worker N (`BUN_TEST_WORKER_ID`, from 1) gets its own database, `<name>_<N>`, so test files never share rows. */
export const workerDatabase = (name: string, worker: string | number) => `${name}_${worker}`;

export function renameDatabase(url: string, rename: (name: string) => string): string {
  const renamed = new URL(url);
  renamed.pathname = `/${rename(renamed.pathname.slice(1))}`;
  return renamed.toString();
}
