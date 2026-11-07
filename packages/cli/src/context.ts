/**
 * What every command shares: the global flags, and a backupd client built
 * from them. Precedence: flag, then environment variable, then the saved
 * config from `backupd login`.
 */
import { makeClient } from "@backupd/sdk/effect";
import { ConfigError } from "@backupd/sdk/effect";
import { Effect, Option } from "effect";
import { Flag, GlobalFlag } from "effect/cli";

import { DEFAULT_API_URL, readConfig } from "./config.js";
import { VERSION } from "./version.js";

export const Json = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDescription("Print results as JSON (for scripts and CI)."),
    Flag.withDefault(false),
  ),
});

export const WorkspaceFlag = GlobalFlag.Setting("workspace")({
  flag: Flag.String("workspace").pipe(
    Flag.withAlias("w"),
    Flag.withDescription(
      "Workspace slug or ID. Defaults to BACKUPD_WORKSPACE, then `backupd workspace use`.",
    ),
    Flag.optional,
  ),
});

export const ApiKeyFlag = GlobalFlag.Setting("api-key")({
  flag: Flag.String("api-key").pipe(
    Flag.withDescription("API key (bkp_…). Defaults to BACKUPD_API_KEY, then `backupd login`."),
    Flag.optional,
  ),
});

export const ApiUrlFlag = GlobalFlag.Setting("api-url")({
  flag: Flag.String("api-url").pipe(Flag.withHidden, Flag.optional),
});

export const GLOBAL_FLAGS = [Json, WorkspaceFlag, ApiKeyFlag, ApiUrlFlag] as const;

const env = (name: string): string | undefined => process.env[name] || undefined;

/** The API URL in effect, without needing a key. */
export const apiUrl = Effect.gen(function* () {
  const flag = yield* ApiUrlFlag;
  const config = yield* readConfig;
  return (
    Option.getOrUndefined(flag) ??
    env("BACKUPD_API_URL") ??
    config.apiUrl ??
    DEFAULT_API_URL
  ).replace(/\/+$/u, "");
});

/** A client for the current key and workspace. Fails if there's no key. */
export const client = Effect.gen(function* () {
  const config = yield* readConfig;
  const apiKey =
    Option.getOrUndefined(yield* ApiKeyFlag) ?? env("BACKUPD_API_KEY") ?? config.apiKey;
  if (!apiKey) {
    return yield* Effect.fail(
      new ConfigError({
        message: "You're not logged in. Run `backupd login`, or set BACKUPD_API_KEY.",
      }),
    );
  }
  const workspace =
    Option.getOrUndefined(yield* WorkspaceFlag) ?? env("BACKUPD_WORKSPACE") ?? config.workspace?.id;
  return makeClient({
    apiKey,
    baseUrl: yield* apiUrl,
    userAgent: `backupd-cli/${VERSION}`,
    workspace,
  });
});
