import type { BackupdClient, Database } from "@backupd/sdk/effect";
import { ConfigError } from "@backupd/sdk/effect";
import { Effect } from "effect";

/** A database by ID or name (names are matched case-insensitively). */
export const findDatabase = (api: BackupdClient, ref: string) =>
  Effect.gen(function* () {
    const databases = yield* api.databases.list();
    const lower = ref.toLowerCase();
    const found =
      databases.find((d) => d.id === ref) ?? databases.find((d) => d.name.toLowerCase() === lower);
    if (!found) {
      return yield* Effect.fail(
        new ConfigError({
          message: `No database "${ref}". Yours: ${databases.map((d) => d.name).join(", ") || "none yet"}.`,
        }),
      );
    }
    return found as Database;
  });

/**
 * A backup ID, or `latest` with a database: the newest finished backup that
 * has a file.
 */
export const backupId = (api: BackupdClient, ref: string, database: string | undefined) =>
  Effect.gen(function* () {
    if (ref !== "latest") {
      return ref;
    }
    if (!database) {
      return yield* Effect.fail(new ConfigError({ message: "`latest` needs --db <database>." }));
    }
    const db = yield* findDatabase(api, database);
    return (yield* api.backups.latest(db.id)).id;
  });

export type Engine = Database["engine"];

/** The engine a connection string is for, from its scheme. */
export const engineOf = (url: string): Exclude<Engine, "convex"> | undefined => {
  const scheme = url.split(":", 1)[0]?.toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") {
    return "postgres";
  }
  if (scheme === "mysql" || scheme === "mariadb") {
    return "mysql";
  }
  if (scheme === "mongodb" || scheme === "mongodb+srv") {
    return "mongodb";
  }
  return undefined;
};
