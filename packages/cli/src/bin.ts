#!/usr/bin/env node
/**
 * backupd: back up, restore and manage your databases from the terminal.
 *
 * Exit codes: 0 ok · 1 failed · 2 usage · 3 not logged in / not allowed ·
 * 4 timed out waiting.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { CliError, Command } from "effect/cli";

import { login, logout, whoami, workspace } from "./commands/auth.js";
import { backup } from "./commands/backups.js";
import { db } from "./commands/databases.js";
import { keys } from "./commands/keys.js";
import { restoreCommand, restores } from "./commands/restores.js";
import { status } from "./commands/status.js";
import { GLOBAL_FLAGS } from "./context.js";
import { describeError } from "./errors.js";
import { VERSION } from "./version.js";

export const root = Command.make("backupd").pipe(
  Command.withDescription(
    "Back up, restore and manage your databases with backupd. https://backupd.dev/cli",
  ),
  Command.withSubcommands([
    login,
    logout,
    whoami,
    workspace,
    db,
    backup,
    restoreCommand,
    restores,
    keys,
    status,
  ]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

const program = Command.run(root, { version: VERSION }).pipe(
  Effect.catch((error: unknown) =>
    Effect.sync(() => {
      if (CliError.isCliError(error)) {
        // Already printed by the parser.
        // Plain --help is a ShowHelp with no errors; a bad flag carries some.
        const failed = error._tag !== "ShowHelp" || error.errors.length > 0;
        process.exitCode = failed ? 2 : 0;
        return;
      }
      const { exitCode, message } = describeError(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = exitCode;
    }),
  ),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
