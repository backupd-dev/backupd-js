import { spawn } from "node:child_process";
import { Readable } from "node:stream";

import { ConfigError, LocalError } from "@backupd/sdk/effect";
import type { RestoreTarget } from "@backupd/sdk/effect";
import { openBackup } from "@backupd/sdk/local";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { Json, client } from "../context.js";
import * as out from "../output.js";
import { backupId as resolveBackupId, findDatabase } from "../resolve.js";
import { keyFlag, readIdentities } from "./backups.js";

/* ------------------------------------------------------------------ */
/* Restoring on this machine                                           */
/* ------------------------------------------------------------------ */

interface ToolCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
}

/** The engine's own restore tool, reading the dump from stdin. */
export const restoreTool = (
  format: string | null,
  target: string,
  replace: boolean,
  oplog = false,
): ToolCall | undefined => {
  switch (format) {
    case "pg_custom": {
      return {
        args: [
          "--no-owner",
          "--no-privileges",
          "--single-transaction",
          ...(replace ? ["--clean", "--if-exists"] : []),
          "-d",
          target,
        ],
        command: "pg_restore",
      };
    }
    case "mongo_archive": {
      return {
        args: [
          "--archive",
          ...(oplog ? ["--oplogReplay"] : []),
          ...(replace ? ["--drop"] : []),
          "--uri",
          target,
        ],
        command: "mongorestore",
      };
    }
    case "mysql_sql":
    case "sql_text": {
      const url = new URL(target);
      const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
      return {
        args: [
          "--host",
          url.hostname,
          ...(url.port ? ["--port", url.port] : []),
          ...(url.username ? ["--user", decodeURIComponent(url.username)] : []),
          ...(database ? [database] : []),
        ],
        command: "mysql",
        // The password goes in the environment, not the process list.
        env: url.password ? { MYSQL_PWD: decodeURIComponent(url.password) } : {},
      };
    }
    default: {
      return undefined;
    }
  }
};

const runTool = (tool: ToolCall, input: ReadableStream<Uint8Array>) =>
  Effect.callback<void, LocalError>((resume) => {
    const child = spawn(tool.command, [...tool.args], {
      env: { ...process.env, ...tool.env },
      stdio: ["pipe", "inherit", "inherit"],
    });
    let settled = false;
    const done = (effect: Effect.Effect<void, LocalError>) => {
      if (!settled) {
        settled = true;
        resume(effect);
      }
    };
    child.on("error", (error: NodeJS.ErrnoException) =>
      done(
        Effect.fail(
          new LocalError({
            cause: error,
            message:
              error.code === "ENOENT"
                ? `${tool.command} isn't installed (or isn't on your PATH). Install your database's client tools and try again.`
                : `Couldn't run ${tool.command}: ${error.message}`,
          }),
        ),
      ),
    );
    child.on("close", (code) =>
      done(
        code === 0
          ? Effect.void
          : Effect.fail(
              new LocalError({ message: `${tool.command} exited with code ${code ?? "unknown"}.` }),
            ),
      ),
    );
    const source = Readable.fromWeb(input as Parameters<typeof Readable.fromWeb>[0]);
    source.on("error", (error) => {
      child.kill();
      done(
        Effect.fail(
          new LocalError({ cause: error, message: `Reading the backup failed: ${error.message}` }),
        ),
      );
    });
    // The tool may exit early (bad credentials); don't crash on EPIPE.
    child.stdin.on("error", () => undefined);
    source.pipe(child.stdin);
    return Effect.sync(() => {
      child.kill();
    });
  });

/* ------------------------------------------------------------------ */

const restore = Command.make(
  "restore",
  {
    backup: Argument.String("backup").pipe(
      Argument.withDescription("Backup ID, or `latest` together with --db."),
    ),
    confirm: Flag.String("confirm").pipe(
      Flag.withDescription("With --to-original: the database's name, to confirm overwriting it."),
      Flag.optional,
    ),
    db: Flag.String("db").pipe(
      Flag.withDescription("Database name or ID (needed with `latest`)."),
      Flag.optional,
    ),
    key: keyFlag,
    local: Flag.Boolean("local").pipe(
      Flag.withDescription(
        "Restore from this machine: download the encrypted file, decrypt it here with --key, and run pg_restore, mysql or mongorestore.",
      ),
      Flag.withDefault(false),
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription("Replace tables that already exist in the target."),
      Flag.withDefault(false),
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("With --wait: give up after this many minutes."),
      Flag.withDefault(360),
    ),
    to: Flag.String("to").pipe(
      Flag.withDescription("Connection string of the database to restore into."),
      Flag.optional,
    ),
    toOriginal: Flag.Boolean("to-original").pipe(
      Flag.withDescription("Overwrite the database the backup came from. Needs --confirm <name>."),
      Flag.withDefault(false),
    ),
    wait: Flag.Boolean("wait").pipe(
      Flag.withDescription("Wait until it finishes; exit non-zero if it fails."),
      Flag.withDefault(false),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const api = yield* client;
      const asJson = yield* Json;
      const id = yield* resolveBackupId(api, flags.backup, Option.getOrUndefined(flags.db));
      const backup = yield* api.backups.get(id);

      if (flags.local) {
        const target = Option.getOrUndefined(flags.to);
        if (!target) {
          return yield* Effect.fail(
            new ConfigError({ message: "--local needs --to <connection string>." }),
          );
        }
        const tool = restoreTool(
          backup.format,
          target,
          flags.replace,
          backup.manifest?.oplog === true,
        );
        if (!tool) {
          return yield* Effect.fail(
            new ConfigError({
              message:
                backup.database.engine === "convex"
                  ? "Convex restores go through the Convex CLI: run `backupd backup download <id> --key <file>`, then `npx convex import --replace-all <file>.zip`."
                  : `Don't know how to restore the ${backup.format ?? "unknown"} format locally. Download it with \`backupd backup download\` instead.`,
            }),
          );
        }
        const identities = yield* readIdentities(flags.key);
        const file = yield* api.backups.download(id, { raw: true });
        yield* out.note(
          `Restoring ${out.bold(backup.fileName)} with ${tool.command}, decrypting on this machine…`,
        );
        yield* runTool(tool, yield* openBackup(file.stream, identities));
        yield* out.success("Restored.");
        return;
      }

      let target: RestoreTarget;
      if (flags.toOriginal) {
        const confirm = Option.getOrUndefined(flags.confirm);
        if (confirm !== backup.database.name) {
          return yield* Effect.fail(
            new ConfigError({
              message: `This overwrites ${backup.database.name}. To confirm, add --confirm ${backup.database.name}.`,
            }),
          );
        }
        target = { confirmName: confirm, kind: "original" };
      } else if (Option.isSome(flags.to)) {
        target = { connectionString: flags.to.value, kind: "custom" };
      } else {
        return yield* Effect.fail(
          new ConfigError({
            message: "Say where to restore: --to <connection string>, or --to-original.",
          }),
        );
      }

      const handle = yield* api.restores.create({
        backupId: id,
        replaceExisting: flags.replace,
        target,
      });
      if (!flags.wait) {
        yield* out.either(
          asJson,
          handle,
          out.success(`Started restore ${out.bold(handle.restoreId)} of ${backup.fileName}.`),
        );
        return;
      }
      yield* out.note(`Restoring ${backup.fileName} ${out.dim(handle.restoreId)}…`);
      const run = yield* api.restores.wait(handle, { timeout: `${flags.timeout} minutes` });
      yield* out.either(
        asJson,
        run,
        out.success(
          `Restored ${run.tablesRestored} tables, ${run.rowsRestored.toLocaleString("en-US")} rows into ${run.targetLabel}.`,
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Restore a backup into another database (--to), the original (--to-original), or from this machine with your own key (--local).",
  ),
);

const list = Command.make(
  "list",
  { db: Flag.String("db").pipe(Flag.withDescription("Database name or ID.")) },
  (flags) =>
    Effect.gen(function* () {
      const api = yield* client;
      const db = yield* findDatabase(api, flags.db);
      const runs = yield* api.restores.list(db.id);
      yield* out.either(
        yield* Json,
        runs,
        out.table(
          runs,
          [
            { header: "ID", value: (r) => r.id },
            {
              header: "Status",
              value: (r) =>
                r.status === "succeeded"
                  ? out.green(r.status)
                  : r.status === "failed"
                    ? out.red(r.status)
                    : r.status,
            },
            { header: "Backup", value: (r) => r.fileName },
            { header: "Into", value: (r) => r.targetLabel },
            { header: "Started", value: (r) => out.ago(r.createdAt) },
            { header: "Error", value: (r) => (r.error ? out.red(r.error) : "") },
          ],
          "No restores yet.",
        ),
      );
    }),
).pipe(Command.withDescription("List a database's recent restores."));

const cancel = Command.make("cancel", { restore: Argument.String("restore") }, ({ restore: id }) =>
  Effect.gen(function* () {
    const api = yield* client;
    yield* api.restores.cancel(id);
    yield* out.success(`Asked restore ${id} to stop.`);
  }),
).pipe(Command.withDescription("Cancel a queued or running restore."));

export const restoreCommand = restore;

export const restores = Command.make("restores").pipe(
  Command.withDescription("List and cancel restores."),
  Command.withSubcommands([list, cancel]),
);
