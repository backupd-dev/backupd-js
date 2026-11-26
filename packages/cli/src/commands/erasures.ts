import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, LocalError } from "@backupd/sdk/effect";
import type { BackupdClient, ErasureScript } from "@backupd/sdk/effect";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { Json, client } from "../context.js";
import * as out from "../output.js";
import { backupId as resolveBackupId, findDatabase } from "../resolve.js";

/* ------------------------------------------------------------------ */
/* Running the script                                                  */
/* ------------------------------------------------------------------ */

interface ScriptRun {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  /** Fed on stdin; mongosh reads a file instead. */
  readonly stdin?: string;
}

/** How each engine's own client runs the ledger script against `target`. */
export const scriptRunner = (
  tool: ErasureScript["tool"],
  target: string,
  scriptFile: string,
  script: string,
): ScriptRun | undefined => {
  switch (tool) {
    case "psql": {
      return {
        args: ["--no-psqlrc", "--quiet", "-v", "ON_ERROR_STOP=1", "-d", target, "-f", "-"],
        command: "psql",
        stdin: script,
      };
    }
    case "mysql": {
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
        env: url.password ? { MYSQL_PWD: decodeURIComponent(url.password) } : {},
        stdin: script,
      };
    }
    case "mongosh": {
      return { args: [target, "--quiet", "--file", scriptFile], command: "mongosh" };
    }
    default: {
      return undefined;
    }
  }
};

const runScript = (run: ScriptRun) =>
  Effect.callback<void, LocalError>((resume) => {
    const child = spawn(run.command, [...run.args], {
      env: { ...process.env, ...run.env },
      stdio: [run.stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"],
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
                ? `${run.command} isn't installed (or isn't on your PATH). Install your database's client tools, or run \`backupd erasures script\` and apply it by hand.`
                : `Couldn't run ${run.command}: ${error.message}`,
          }),
        ),
      ),
    );
    child.on("close", (code) =>
      done(
        code === 0
          ? Effect.void
          : Effect.fail(
              new LocalError({
                message: `${run.command} exited with code ${code ?? "unknown"}: the erasures were not applied (SQL engines roll back the whole script).`,
              }),
            ),
      ),
    );
    if (run.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(run.stdin);
    }
    return Effect.sync(() => {
      child.kill();
    });
  });

/**
 * Re-applies the ledger for one backup (or every request) to a database
 * restored outside backupd, then reports it. Resolves how many requests ran.
 */
export const applyErasures = (
  api: BackupdClient,
  input: { databaseId: string; backupId?: string | undefined; target: string },
) =>
  Effect.gen(function* () {
    const result = yield* api.erasures.script(input.databaseId, input.backupId);
    if (!result.script || result.count === 0) {
      return 0;
    }
    if (!result.tool) {
      return yield* Effect.fail(
        new ConfigError({
          message:
            "Convex can't be erased from the CLI: run `backupd erasures script` and delete the rows with a Convex mutation.",
        }),
      );
    }
    const script = result.script;
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "backupd-erasures-")));
    const scriptFile = join(dir, "erasures.js");
    try {
      if (result.tool === "mongosh") {
        yield* Effect.promise(() => writeFile(scriptFile, script, { mode: 0o600 }));
      }
      const run = scriptRunner(result.tool, input.target, scriptFile, script);
      if (!run) {
        return 0;
      }
      yield* out.note(
        `Re-applying ${result.count} erasure request${result.count === 1 ? "" : "s"} with ${run.command}…`,
      );
      yield* runScript(run);
    } finally {
      yield* Effect.promise(() => rm(dir, { force: true, recursive: true }));
    }
    yield* api.erasures.markApplied(input.databaseId, result.requestIds, input.backupId);
    return result.count;
  });

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

const databaseArg = Argument.String("database").pipe(
  Argument.withDescription("Database name or ID."),
);
const backupFlag = Flag.String("backup").pipe(
  Flag.withDescription(
    "The backup you restored (ID or `latest`): only people erased after it was taken. Default: every request.",
  ),
  Flag.optional,
);

const list = Command.make("list", { database: databaseArg }, (flags) =>
  Effect.gen(function* () {
    const api = yield* client;
    const db = yield* findDatabase(api, flags.database);
    const ledger = yield* api.erasures.list(db.id);
    yield* out.either(
      yield* Json,
      ledger,
      out.table(
        ledger.requests,
        [
          { header: "Person", value: (r) => r.value },
          { header: "Rule", value: (r) => r.ruleName },
          { header: "Reference", value: (r) => r.reference ?? "" },
          { header: "Erased", value: (r) => out.ago(r.erasedAt) },
          {
            header: "Backups holding them",
            value: (r) => (r.backupsHolding === 0 ? out.green("none") : String(r.backupsHolding)),
          },
        ],
        "No open erasure requests.",
      ),
    );
  }),
).pipe(Command.withDescription("List a database's open erasure requests."));

const rules = Command.make("rules", { database: databaseArg }, (flags) =>
  Effect.gen(function* () {
    const api = yield* client;
    const db = yield* findDatabase(api, flags.database);
    const result = yield* api.erasures.rules(db.id);
    yield* out.either(
      yield* Json,
      result,
      out.table(
        result.rules,
        [
          { header: "Rule", value: (r) => r.name },
          {
            header: "Steps",
            value: (r) =>
              r.steps
                .map((s) => `${s.schema ? `${s.schema}.` : ""}${s.table}.${s.column}`)
                .join(" → "),
          },
          { header: "Open requests", value: (r) => String(r.requests) },
        ],
        "No erasure rules yet. Add one in the app: the database's Privacy tab.",
      ),
    );
  }),
).pipe(Command.withDescription("List a database's erasure rules."));

const LIST_SEPARATOR = /[\n,]/u;

const add = Command.make(
  "add",
  {
    database: databaseArg,
    erasedAt: Flag.String("erased-at").pipe(
      Flag.withDescription(
        "When they were deleted from the live database (ISO 8601). Default: now.",
      ),
      Flag.optional,
    ),
    fromFile: Flag.String("from-file").pipe(
      Flag.withDescription("Read identifiers from a file, one per line (- for stdin)."),
      Flag.optional,
    ),
    reference: Flag.String("reference").pipe(
      Flag.withDescription("Your reference, e.g. the request's ticket ID."),
      Flag.optional,
    ),
    rule: Flag.String("rule").pipe(Flag.withDescription("Erasure rule name or ID.")),
    values: Argument.String("identifiers").pipe(
      Argument.withDescription("Identifiers, comma-separated (e.g. user IDs or emails)."),
      Argument.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const api = yield* client;
      const db = yield* findDatabase(api, flags.database);
      const { rules: found } = yield* api.erasures.rules(db.id);
      const wanted = flags.rule.toLowerCase();
      const rule = found.find((r) => r.id === flags.rule || r.name.toLowerCase() === wanted);
      if (!rule) {
        return yield* Effect.fail(
          new ConfigError({
            message: `No erasure rule "${flags.rule}" on ${db.name}. Rules: ${found.map((r) => r.name).join(", ") || "none yet (add one in the app: the database's Privacy tab)"}.`,
          }),
        );
      }
      let raw = Option.getOrElse(flags.values, () => "");
      if (Option.isSome(flags.fromFile)) {
        const path = flags.fromFile.value;
        raw += `\n${yield* Effect.promise(() =>
          path === "-"
            ? new Response(process.stdin as unknown as ReadableStream).text()
            : readFile(path, "utf8"),
        )}`;
      }
      const values = [
        ...new Set(
          raw
            .split(LIST_SEPARATOR)
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ];
      if (values.length === 0) {
        return yield* Effect.fail(
          new ConfigError({ message: "Give identifiers (comma-separated) or --from-file." }),
        );
      }
      let recorded = 0;
      let duplicates = 0;
      for (let start = 0; start < values.length; start += 100) {
        const result = yield* api.erasures.record({
          databaseId: db.id,
          erasedAt: Option.getOrUndefined(flags.erasedAt),
          reference: Option.getOrUndefined(flags.reference),
          ruleId: rule.id,
          source: "cli",
          values: values.slice(start, start + 100),
        });
        recorded += result.recorded;
        duplicates += result.duplicates;
      }
      yield* out.either(
        yield* Json,
        { duplicates, recorded },
        out.success(
          `Recorded ${recorded} erasure${recorded === 1 ? "" : "s"} on ${db.name}${duplicates ? out.dim(` (${duplicates} already in the ledger)`) : ""}. Restores of older backups will delete them again.`,
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Record people you erased from the live database, so restores of older backups delete them again.",
  ),
);

const script = Command.make("script", { backup: backupFlag, database: databaseArg }, (flags) =>
  Effect.gen(function* () {
    const api = yield* client;
    const db = yield* findDatabase(api, flags.database);
    const backup = Option.isSome(flags.backup)
      ? yield* resolveBackupId(api, flags.backup.value, db.id)
      : undefined;
    const result = yield* api.erasures.script(db.id, backup);
    if (yield* Json) {
      yield* out.json(result);
      return;
    }
    if (!result.script) {
      yield* out.note("Nothing to re-apply: no one was erased after that backup.");
      return;
    }
    process.stdout.write(result.script);
  }),
).pipe(
  Command.withDescription(
    "Print the script that re-applies the ledger (SQL for psql/mysql, JavaScript for mongosh). It holds the identifiers in plain text.",
  ),
);

const apply = Command.make(
  "apply",
  {
    backup: backupFlag,
    database: databaseArg,
    target: Flag.String("target").pipe(
      Flag.withDescription("Connection string of the database you restored into."),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const api = yield* client;
      const db = yield* findDatabase(api, flags.database);
      const backup = Option.isSome(flags.backup)
        ? yield* resolveBackupId(api, flags.backup.value, db.id)
        : undefined;
      const count = yield* applyErasures(api, {
        backupId: backup,
        databaseId: db.id,
        target: flags.target,
      });
      yield* count === 0
        ? out.success("Nothing to re-apply: no one was erased after that backup.")
        : out.success(`Re-applied ${count} erasure request${count === 1 ? "" : "s"}.`);
    }),
).pipe(
  Command.withDescription(
    "After restoring a backup yourself: delete everyone erased since it was taken, with psql, mysql or mongosh.",
  ),
);

export const erasures = Command.make("erasures").pipe(
  Command.withDescription(
    "The erasure ledger (GDPR): record erased people, and re-apply erasures after restoring a backup yourself.",
  ),
  Command.withSubcommands([list, rules, add, apply, script]),
);
