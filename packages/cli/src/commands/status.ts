import type { Database } from "@backupd/sdk/effect";
import { Data, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { Json, client } from "../context.js";
import * as out from "../output.js";

/** `status` found at least one database that needs attention. */
export class Unhealthy extends Data.TaggedError("Unhealthy")<{ readonly message: string }> {}

export interface Check {
  readonly database: string;
  readonly ok: boolean;
  readonly reason: string;
}

/** Judges one database: a recent, successful backup, not failing restore tests. */
export const checkDatabase = (db: Database, maxAgeHours: number, now = Date.now()): Check => {
  const base = { database: db.name };
  if (db.status === "paused") {
    return { ...base, ok: true, reason: "paused" };
  }
  const last = db.lastBackup;
  if (last?.status === "failed") {
    return { ...base, ok: false, reason: "last backup failed" };
  }
  if (last?.status === "succeeded" && last.verificationStatus === "failed") {
    return { ...base, ok: false, reason: "last restore test failed" };
  }
  if (!db.lastBackupAt) {
    return { ...base, ok: false, reason: "no successful backup yet" };
  }
  const hours = (now - Date.parse(db.lastBackupAt)) / 3_600_000;
  if (hours > maxAgeHours) {
    return { ...base, ok: false, reason: `last successful backup ${Math.round(hours)}h ago` };
  }
  return { ...base, ok: true, reason: `backed up ${out.ago(db.lastBackupAt)}` };
};

export const status = Command.make(
  "status",
  {
    maxAge: Flag.Int("max-age").pipe(
      Flag.withDescription(
        "Hours since the last successful backup before a database counts as stale.",
      ),
      Flag.withDefault(26),
    ),
  },
  ({ maxAge }) =>
    Effect.gen(function* () {
      const api = yield* client;
      const databases = yield* api.databases.list();
      const checks = databases.map((db) => checkDatabase(db, maxAge));
      const failing = checks.filter((c) => !c.ok);
      yield* out.either(
        yield* Json,
        { checks, ok: failing.length === 0 },
        out.table(
          checks,
          [
            { header: "", value: (c) => (c.ok ? out.green("✓") : out.red("✗")) },
            { header: "Database", value: (c) => c.database },
            { header: "", value: (c) => (c.ok ? out.dim(c.reason) : out.red(c.reason)) },
          ],
          "No databases yet.",
        ),
      );
      if (failing.length > 0) {
        return yield* Effect.fail(
          new Unhealthy({
            message: `${failing.length} of ${checks.length} databases need attention.`,
          }),
        );
      }
    }),
).pipe(
  Command.withDescription(
    "Check every database has a recent successful backup. Exits 1 if not, for CI and cron.",
  ),
);
