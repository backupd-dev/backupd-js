/**
 * The Promise API:
 *
 * ```ts
 * import { Backupd } from "@backupd/sdk";
 *
 * const backupd = new Backupd({ apiKey: process.env.BACKUPD_API_KEY, workspace: "acme" });
 * const { backupId } = await backupd.backups.trigger("db_123");
 * const backup = await backupd.backups.wait(backupId);
 * ```
 *
 * Errors are thrown as the classes in `./errors` (`ApiError`, `ConfigError`,
 * `NetworkError`, `OperationFailed`, …); check `error._tag` or `instanceof`.
 * For the Effect API, import from `@backupd/sdk/effect`.
 */
import { Cause, Effect, Exit } from "effect";

import { makeClient } from "./client.js";
import type { BackupdClient, ClientOptions } from "./client.js";

/** An Effect-returning API, with each Effect turned into a Promise. */
export type Promisified<T> = T extends (
  ...args: infer Args
) => Effect.Effect<infer A, infer _E, never>
  ? (...args: Args) => Promise<A>
  : T extends Effect.Effect<infer A, infer _E, never>
    ? () => Promise<A>
    : T extends Record<string, unknown>
      ? { readonly [K in keyof T]: Promisified<T[K]> }
      : T;

const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  // Tagged errors are real Error instances; throw them as they are.
  throw Cause.squash(exit.cause);
};

const promisify = (value: unknown): unknown => {
  if (Effect.isEffect(value)) {
    return () => run(value as Effect.Effect<unknown, unknown>);
  }
  if (typeof value === "function") {
    return (...args: unknown[]) => {
      const result: unknown = (value as (...a: unknown[]) => unknown)(...args);
      return Effect.isEffect(result) ? run(result as Effect.Effect<unknown, unknown>) : result;
    };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, promisify(inner)]));
  }
  return value;
};

// The class's methods are added in the constructor from `makeClient`, and
// this interface declares them. Every one is assigned, so merging is safe.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export interface Backupd extends Promisified<BackupdClient> {}

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export class Backupd {
  constructor(options: ClientOptions = {}) {
    Object.assign(this, promisify(makeClient(options)));
  }
}

export { DEFAULT_BASE_URL, SDK_VERSION } from "./client.js";
export type {
  ClientOptions,
  Connection,
  CreateDatabaseInput,
  CreateRestoreInput,
  Download,
  DownloadOptions,
  ListBackupsOptions,
  RestoreHandle,
  RestoreTarget,
  WaitOptions,
} from "./client.js";
export * from "./errors.js";
export type * from "./schemas.js";
