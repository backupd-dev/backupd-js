import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";

import type { Backup, BackupSummary } from "@backupd/sdk/effect";
import { LocalError } from "@backupd/sdk/effect";
import { openBackup, parseKeyFile } from "@backupd/sdk/local";
import { Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { Json, client } from "../context.js";
import * as out from "../output.js";
import { backupId as resolveBackupId, findDatabase } from "../resolve.js";

const backupArg = Argument.String("backup").pipe(
  Argument.withDescription("Backup ID, or `latest` together with --db."),
);
const dbFlag = Flag.String("db").pipe(Flag.withDescription("Database name or ID."), Flag.optional);

const statusText = (b: Pick<Backup, "status" | "phase" | "verificationStatus">): string => {
  switch (b.status) {
    case "queued": {
      return out.dim("queued");
    }
    case "running": {
      return out.cyan(b.phase ?? "running");
    }
    case "failed": {
      return out.red("failed");
    }
    case "cancelled": {
      return out.dim("cancelled");
    }
    default: {
      if (b.verificationStatus === "verified") {
        return out.green("verified");
      }
      return b.verificationStatus === "failed"
        ? out.red("restore test failed")
        : out.green("succeeded");
    }
  }
};

/** Prints status changes while waiting, one line each. */
const progressPrinter = () => {
  let last = "";
  return (b: Backup) => {
    const line = b.status === "running" ? `running: ${b.phase ?? "starting"}` : b.status;
    if (line !== last) {
      last = line;
      process.stderr.write(`${out.dim("…")} ${line}\n`);
    }
  };
};

const summaryLines = (b: Backup) =>
  out.details([
    ["Backup", b.id],
    [
      "Database",
      `${b.database.name} (${b.database.engine}${b.database.engineVersion ? ` ${b.database.engineVersion}` : ""})`,
    ],
    ["File", b.fileName],
    ["Status", statusText(b)],
    ["Started", `${b.startedAt} (${out.ago(b.startedAt)})`],
    ["Took", b.durationMs === null ? "–" : `${Math.round(b.durationMs / 1000)}s`],
    [
      "Stored",
      `${out.bytes(b.sizeBytes)}${b.plaintextSizeBytes ? ` (${out.bytes(b.plaintextSizeBytes)} uncompressed)` : ""}`,
    ],
    [
      "Restore test",
      b.verificationDetails
        ? `${b.verificationDetails.tablesChecked} tables, ${b.verificationDetails.rowsChecked.toLocaleString("en-US")} rows checked against ${b.verificationDetails.sandbox}${b.verificationDetails.mismatches.length > 0 ? out.red(`, ${b.verificationDetails.mismatches.length} mismatched`) : ""}`
        : b.verificationStatus,
    ],
    ...(b.errorMessage ? ([["Error", out.red(b.errorMessage)]] as const) : []),
  ]);

const now = Command.make(
  "now",
  {
    database: Argument.String("database").pipe(Argument.withDescription("Database name or ID.")),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("With --wait: give up after this many minutes."),
      Flag.withDefault(360),
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
      const db = yield* findDatabase(api, flags.database);
      const started = yield* api.backups.trigger(db.id);
      if (!flags.wait) {
        yield* out.either(
          asJson,
          started,
          Effect.andThen(
            out.success(
              `Started a backup of ${started.databaseName}: ${out.bold(started.backupId)}`,
            ),
            out.note(
              out.dim(
                `${started.quota.remaining} manual backups left today. Follow it with \`backupd backup get ${started.backupId}\`.`,
              ),
            ),
          ),
        );
        return;
      }
      yield* out.note(`Backing up ${started.databaseName} ${out.dim(started.backupId)}`);
      const backup = yield* api.backups.wait(started.backupId, {
        onProgress: asJson ? undefined : progressPrinter(),
        timeout: `${flags.timeout} minutes`,
      });
      yield* out.either(
        asJson,
        backup,
        Effect.andThen(
          out.success(`Backup finished: ${out.bytes(backup.sizeBytes)} stored.`),
          summaryLines(backup),
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Back up a database now. Counts against your plan's manual backups per day.",
  ),
);

const list = Command.make(
  "list",
  {
    db: dbFlag,
    deleted: Flag.Boolean("deleted").pipe(
      Flag.withDescription("Show recently deleted backups."),
      Flag.withDefault(false),
    ),
    limit: Flag.Int("limit").pipe(Flag.withDescription("1–100."), Flag.withDefault(20)),
  },
  (flags) =>
    Effect.gen(function* () {
      const api = yield* client;
      const databaseId = Option.isSome(flags.db)
        ? (yield* findDatabase(api, flags.db.value)).id
        : undefined;
      const page = yield* api.backups.list({
        databaseId,
        deleted: flags.deleted,
        limit: flags.limit,
      });
      yield* out.either(
        yield* Json,
        page,
        out.table<BackupSummary>(
          page.items,
          [
            { header: "ID", value: (b) => b.id },
            { header: "Database", value: (b) => b.databaseName },
            { header: "Status", value: statusText },
            { header: "Started", value: (b) => out.ago(b.startedAt) },
            { align: "right", header: "Stored", value: (b) => out.bytes(b.sizeBytes) },
            { header: "Trigger", value: (b) => out.dim(b.trigger) },
          ],
          flags.deleted ? "No recently deleted backups." : "No backups yet.",
        ),
      );
      if (!(yield* Json) && page.total > page.items.length) {
        yield* out.note(
          out.dim(`Showing ${page.items.length} of ${page.total}. Use --limit for more.`),
        );
      }
    }),
).pipe(Command.withDescription("List backups, newest first."));

const get = Command.make("get", { backup: backupArg, db: dbFlag }, (flags) =>
  Effect.gen(function* () {
    const api = yield* client;
    const id = yield* resolveBackupId(api, flags.backup, Option.getOrUndefined(flags.db));
    const backup = yield* api.backups.get(id);
    yield* out.either(yield* Json, backup, summaryLines(backup));
  }),
).pipe(Command.withDescription("Show one backup, including its restore test."));

const cancel = Command.make(
  "cancel",
  { backup: Argument.String("backup").pipe(Argument.withDescription("Backup ID.")) },
  ({ backup }) =>
    Effect.gen(function* () {
      const api = yield* client;
      const result = yield* api.backups.cancel(backup);
      yield* out.success(`Cancelled ${result.fileName}.`);
    }),
).pipe(Command.withDescription("Stop a queued or running backup."));

/** Writes a web stream to a file, or to stdout for `-`. */
export const writeStream = (stream: ReadableStream<Uint8Array>, path: string) =>
  Effect.tryPromise({
    catch: (cause) =>
      new LocalError({
        cause,
        message: `Couldn't write ${path === "-" ? "to stdout" : path}: ${String(cause)}`,
      }),
    try: () =>
      stream.pipeTo(
        Writable.toWeb(
          path === "-" ? process.stdout : createWriteStream(path, { mode: 0o600 }),
        ) as WritableStream<Uint8Array>,
      ),
  });

/** Reads secret keys from a key file, or from BACKUPD_AGE_KEY. */
export const readIdentities = (keyFile: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(keyFile)) {
      const fromEnv = process.env.BACKUPD_AGE_KEY;
      if (fromEnv) {
        return yield* parseKeyFile(fromEnv);
      }
      return yield* Effect.fail(
        new LocalError({
          message: "Pass --key <file> with your age secret key (or set BACKUPD_AGE_KEY).",
        }),
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(keyFile.value)
      .pipe(
        Effect.mapError(
          (cause) => new LocalError({ cause, message: `Couldn't read ${keyFile.value}.` }),
        ),
      );
    return yield* parseKeyFile(text);
  });

export const keyFlag = Flag.String("key").pipe(
  Flag.withAlias("k"),
  Flag.withDescription(
    "Your age key file. Decrypts on this machine; nothing is decrypted by backupd.",
  ),
  Flag.optional,
);

const download = Command.make(
  "download",
  {
    backup: backupArg,
    db: dbFlag,
    key: keyFlag,
    output: Flag.String("output").pipe(
      Flag.withAlias("o"),
      Flag.withDescription("Where to write it (`-` for stdout). Defaults to the file's own name."),
      Flag.optional,
    ),
    raw: Flag.Boolean("raw").pipe(
      Flag.withDescription("Save the file as stored: encrypted and compressed (.zst.age)."),
      Flag.withDefault(false),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const api = yield* client;
      const id = yield* resolveBackupId(api, flags.backup, Option.getOrUndefined(flags.db));
      const local =
        Option.isSome(flags.key) || (!flags.raw && Boolean(process.env.BACKUPD_AGE_KEY));
      // With a key, fetch the stored file and open it here.
      const file = yield* api.backups.download(id, { raw: flags.raw || local });
      let stream: ReadableStream<Uint8Array<ArrayBufferLike>> = file.stream;
      let name = file.fileName;
      if (local && !flags.raw) {
        stream = yield* openBackup(stream, yield* readIdentities(flags.key));
        name = name.replace(/\.zst\.age$/u, "");
      }
      const path = Option.getOrElse(flags.output, () => name);
      if (path !== "-") {
        yield* out.note(
          `Downloading ${out.bold(name)}${file.size ? ` (${out.bytes(file.size)})` : ""}…`,
        );
      }
      yield* writeStream(stream, path);
      if (path !== "-") {
        yield* out.success(
          `Saved ${path}${local && !flags.raw ? out.dim(" (decrypted on this machine)") : ""}`,
        );
      }
    }),
).pipe(
  Command.withDescription(
    "Download a backup: the plain dump, the stored file (--raw), or decrypted here with your own key (--key).",
  ),
);

const quota = Command.make("quota", { database: Argument.String("database") }, ({ database }) =>
  Effect.gen(function* () {
    const api = yield* client;
    const db = yield* findDatabase(api, database);
    const q = yield* api.backups.quota(db.id);
    yield* out.either(
      yield* Json,
      q,
      out.details([
        ["Manual backups left", `${q.remaining} of ${q.limit} (rolling 24 hours)`],
        ["Next one frees up", q.resetAt ? out.ago(q.resetAt) : "–"],
      ]),
    );
  }),
).pipe(Command.withDescription("How many manual backups a database has left today."));

export const backup = Command.make("backup").pipe(
  Command.withDescription("Start, list, inspect and download backups."),
  Command.withSubcommands([now, list, get, download, cancel, quota]),
);
