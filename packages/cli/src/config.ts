/**
 * Where the CLI keeps its login: one JSON file, readable only by you.
 *
 *   Linux/macOS  $XDG_CONFIG_HOME/backupd/config.json  (default ~/.config)
 *   Windows      %APPDATA%\backupd\config.json
 *
 * Flags beat environment variables, which beat the file.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, FileSystem, Option, Schema } from "effect";

export const DEFAULT_API_URL = "https://api.backupd.dev";

const StoredWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
});

export const StoredConfig = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.String),
  /** The API key's ID, so `logout` can revoke it. */
  apiKeyId: Schema.optionalKey(Schema.String),
  apiUrl: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(StoredWorkspace),
});
export type StoredConfig = typeof StoredConfig.Type;

export const configDir = (): string => {
  const env = process.env;
  if (env.BACKUPD_CONFIG_DIR) {
    return env.BACKUPD_CONFIG_DIR;
  }
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "backupd");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "backupd");
};

export const configPath = (): string => join(configDir(), "config.json");

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredConfig));

/** The saved config, or an empty one if there is none or it can't be read. */
export const readConfig: Effect.Effect<StoredConfig, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(configPath()).pipe(Effect.option);
    if (Option.isNone(text)) {
      return {};
    }
    return yield* decode(text.value).pipe(Effect.orElseSucceed(() => ({})));
  },
);

/** Saves the config with owner-only permissions. */
export const writeConfig = (config: StoredConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(configDir(), { mode: 0o700, recursive: true });
    const path = configPath();
    yield* fs.writeFileString(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    // writeFile keeps an existing file's mode; make sure it's private.
    yield* fs.chmod(path, 0o600).pipe(Effect.ignore);
  });

export const updateConfig = (patch: (config: StoredConfig) => StoredConfig) =>
  Effect.flatMap(readConfig, (config) => writeConfig(patch(config)));

export const removeConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(configPath()).pipe(Effect.ignore);
});
