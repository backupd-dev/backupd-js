import type { Connection, Database } from "@backupd/sdk/effect";
import { ConfigError } from "@backupd/sdk/effect";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { Json, client } from "../context.js";
import * as out from "../output.js";
import { engineOf, findDatabase } from "../resolve.js";

const ENGINE_LABEL: Record<Database["engine"], string> = {
  convex: "Convex",
  mongodb: "MongoDB",
  mysql: "MySQL",
  postgres: "PostgreSQL",
};

const SCHEDULE_LABEL = {
  "12h": "every 12 hours",
  "24h": "every 24 hours",
  "6h": "every 6 hours",
} as const;

const health = (db: Database): string => {
  if (db.status === "paused") {
    return out.dim("paused");
  }
  const last = db.lastBackup;
  if (!last) {
    return out.dim("no backups yet");
  }
  if (last.status === "failed") {
    return out.red("last backup failed");
  }
  if (last.status === "queued" || last.status === "running") {
    return out.cyan("backing up");
  }
  if (last.verificationStatus === "failed") {
    return out.red("restore test failed");
  }
  return last.verificationStatus === "verified"
    ? out.green("healthy · verified")
    : out.green("healthy");
};

const databaseArg = Argument.String("database").pipe(
  Argument.withDescription("Database name or ID."),
);

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const api = yield* client;
    const databases = yield* api.databases.list();
    yield* out.either(
      yield* Json,
      databases,
      out.table(
        databases,
        [
          { header: "Name", value: (d) => out.bold(d.name) },
          {
            header: "Engine",
            value: (d) => [ENGINE_LABEL[d.engine], d.engineVersion].filter(Boolean).join(" "),
          },
          { header: "Status", value: health },
          { header: "Schedule", value: (d) => SCHEDULE_LABEL[d.schedule] },
          { align: "right", header: "Stored", value: (d) => out.bytes(d.totalBytes) },
          { align: "right", header: "Last backup", value: (d) => out.ago(d.lastBackupAt) },
          { header: "ID", value: (d) => out.dim(d.id) },
        ],
        "No databases yet. Add one with `backupd db add`.",
      ),
    );
  }),
).pipe(Command.withDescription("List databases and their backup health."));

const get = Command.make("get", { database: databaseArg }, ({ database }) =>
  Effect.gen(function* () {
    const api = yield* client;
    const db = yield* findDatabase(api, database);
    const detail = yield* api.databases.get(db.id);
    const percent = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
    yield* out.either(
      yield* Json,
      detail,
      out.details([
        ["Name", detail.name],
        ["ID", detail.id],
        ["Engine", [ENGINE_LABEL[detail.engine], detail.engineVersion].filter(Boolean).join(" ")],
        ["Host", detail.host],
        ["Status", health(db)],
        [
          "Schedule",
          `${SCHEDULE_LABEL[detail.effectiveSchedule]} from ${String(detail.scheduleHour).padStart(2, "0")}:00 UTC`,
        ],
        ["Keeps", `${detail.retentionDays} days`],
        ["Next backup", detail.nextRunAt ? out.ago(detail.nextRunAt) : "–"],
        ["Backups", `${detail.stats.fileCount}, ${out.bytes(detail.stats.totalBytes)} stored`],
        ["Success (30 days)", percent(detail.stats.successRate)],
        ["Restore-tested", percent(detail.stats.verifiedRate)],
      ]),
    );
  }),
).pipe(Command.withDescription("Show one database."));

const connectionFlags = {
  convexUrl: Flag.String("convex-url").pipe(
    Flag.withDescription("Convex deployment URL."),
    Flag.optional,
  ),
  deployKey: Flag.String("deploy-key").pipe(
    Flag.withDescription("Convex deploy key."),
    Flag.optional,
  ),
  selfHosted: Flag.Boolean("self-hosted").pipe(
    Flag.withDescription("The Convex deployment is self-hosted."),
    Flag.withDefault(false),
  ),
  url: Flag.String("url").pipe(
    Flag.withDescription(
      "Connection string (postgres://, mysql://, mongodb://…). Defaults to $DATABASE_URL.",
    ),
    Flag.optional,
  ),
};

const connectionFrom = (flags: {
  readonly url: Option.Option<string>;
  readonly convexUrl: Option.Option<string>;
  readonly deployKey: Option.Option<string>;
  readonly selfHosted: boolean;
}): Effect.Effect<Connection, ConfigError> => {
  if (Option.isSome(flags.convexUrl) || Option.isSome(flags.deployKey)) {
    if (Option.isNone(flags.convexUrl) || Option.isNone(flags.deployKey)) {
      return Effect.fail(
        new ConfigError({ message: "Convex needs both --convex-url and --deploy-key." }),
      );
    }
    return Effect.succeed({
      deployKey: flags.deployKey.value,
      deploymentUrl: flags.convexUrl.value,
      engine: "convex",
      selfHosted: flags.selfHosted,
    });
  }
  const url = Option.getOrUndefined(flags.url) ?? process.env.DATABASE_URL;
  if (!url) {
    return Effect.fail(
      new ConfigError({ message: "Pass --url <connection string> (or set DATABASE_URL)." }),
    );
  }
  const engine = engineOf(url);
  if (!engine) {
    return Effect.fail(
      new ConfigError({
        message: "Couldn't tell the engine from the URL. Use postgres://, mysql:// or mongodb://.",
      }),
    );
  }
  return Effect.succeed({ connectionString: url, engine });
};

const test = Command.make("test", connectionFlags, (flags) =>
  Effect.gen(function* () {
    const api = yield* client;
    const result = yield* api.databases.testConnection(yield* connectionFrom(flags));
    if (yield* Json) {
      yield* out.json(result);
    } else if (result.ok) {
      yield* out.success(
        `Connected: ${result.probe.engineVersion}${result.probe.sizeBytes ? `, ${out.bytes(result.probe.sizeBytes)}` : ""}`,
      );
    } else {
      yield* out.note(`${out.red("✗")} ${result.message} ${out.dim(`(${result.code})`)}`);
    }
    if (!result.ok) {
      return yield* Effect.fail(new ConfigError({ message: "The connection test failed." }));
    }
  }),
).pipe(Command.withDescription("Check that backupd can reach a database, without saving it."));

const add = Command.make(
  "add",
  {
    ...connectionFlags,
    every: Flag.Literals("every", ["6h", "12h", "24h"]).pipe(
      Flag.withDescription("How often to back up. Your plan may not allow 6h."),
      Flag.withDefault("24h" as const),
    ),
    hour: Flag.Int("hour").pipe(
      Flag.withDescription("UTC hour (0–23) the schedule starts from."),
      Flag.optional,
    ),
    keepDays: Flag.Int("keep-days").pipe(
      Flag.withDescription("Days to keep backups."),
      Flag.withDefault(30),
    ),
    name: Flag.String("name").pipe(Flag.withDescription("A name for the database in backupd.")),
  },
  (flags) =>
    Effect.gen(function* () {
      const api = yield* client;
      const connection = yield* connectionFrom(flags);
      const created = yield* api.databases.create({
        connection,
        name: flags.name,
        retentionDays: flags.keepDays,
        schedule: flags.every,
        ...(Option.isSome(flags.hour) ? { scheduleHour: flags.hour.value } : {}),
      });
      yield* out.either(
        yield* Json,
        created,
        Effect.andThen(
          out.success(`Added ${out.bold(created.name)} ${out.dim(created.id)}`),
          out.note(
            created.nextRunAt
              ? `First backup ${out.ago(created.nextRunAt)}. Run \`backupd backup now ${created.name}\` to start one now.`
              : "",
          ),
        ),
      );
    }),
).pipe(Command.withDescription("Add a database and start backing it up on a schedule."));

const setStatus = (name: "pause" | "resume") =>
  Command.make(name, { database: databaseArg }, ({ database }) =>
    Effect.gen(function* () {
      const api = yield* client;
      const db = yield* findDatabase(api, database);
      yield* name === "pause" ? api.databases.pause(db.id) : api.databases.resume(db.id);
      yield* out.success(`${name === "pause" ? "Paused" : "Resumed"} ${db.name}.`);
    }),
  ).pipe(
    Command.withDescription(
      name === "pause"
        ? "Stop scheduled backups. Existing backups are kept."
        : "Start scheduled backups again.",
    ),
  );

const remove = Command.make(
  "rm",
  {
    database: databaseArg,
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Don't ask."),
      Flag.withDefault(false),
    ),
  },
  ({ database, yes }) =>
    Effect.gen(function* () {
      const api = yield* client;
      const db = yield* findDatabase(api, database);
      if (!yes) {
        return yield* Effect.fail(
          new ConfigError({
            message: `Removing ${db.name} stops its backups. Run again with --yes to confirm.`,
          }),
        );
      }
      yield* api.databases.remove(db.id);
      yield* out.success(`Removed ${db.name}.`);
    }),
).pipe(
  Command.withDescription(
    "Remove a database. The API refuses while it still has backups; delete or let them expire first.",
  ),
);

export const db = Command.make("db").pipe(
  Command.withDescription("Add, list and manage databases."),
  Command.withSubcommands([list, get, add, test, setStatus("pause"), setStatus("resume"), remove]),
);
