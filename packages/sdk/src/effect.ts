/**
 * The Effect API. Each method returns an `Effect` with typed errors:
 *
 * ```ts
 * import { Backupd } from "@backupd/sdk/effect";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const backupd = yield* Backupd;
 *   const { backupId } = yield* backupd.backups.trigger("db_123");
 *   return yield* backupd.backups.wait(backupId);
 * });
 *
 * Effect.runPromise(program.pipe(Effect.provide(Backupd.layer({ workspace: "acme" }))));
 * ```
 */
import { Context, Layer } from "effect";

import { makeClient } from "./client.js";
import type { BackupdClient, ClientOptions } from "./client.js";

export class Backupd extends Context.Service<Backupd, BackupdClient>()("@backupd/sdk/Backupd") {
  /** A layer with a client built from these options (or the environment). */
  static readonly layer = (options: ClientOptions = {}): Layer.Layer<Backupd> =>
    Layer.succeed(Backupd, makeClient(options));
}

export { makeClient } from "./client.js";
export type * from "./client.js";
export * from "./errors.js";
export * as Schemas from "./schemas.js";
export type * from "./schemas.js";
