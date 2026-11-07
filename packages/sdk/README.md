# @backupd/sdk

TypeScript SDK for [backupd](https://backupd.dev): back up, restore and manage databases from code. Promise and [Effect](https://effect.website) APIs, typed errors, and tools to decrypt backups with your own key.

```sh
npm i @backupd/sdk
```

Node.js 22.15+ or Bun. Server-side only: keep your API key off the browser.

## Promise API

```ts
import { Backupd, OperationFailed } from "@backupd/sdk";

const backupd = new Backupd({
  apiKey: process.env.BACKUPD_API_KEY, // default: BACKUPD_API_KEY
  workspace: "acme", // slug or ID; default: BACKUPD_WORKSPACE, or your only workspace
});

const databases = await backupd.databases.list();

const { backupId } = await backupd.backups.trigger(databases[0].id);
try {
  const backup = await backupd.backups.wait(backupId, { onProgress: (b) => console.log(b.phase) });
  console.log(backup.sizeBytes, backup.verificationStatus);
} catch (error) {
  if (error instanceof OperationFailed) console.error(error.message);
  throw error;
}

const restore = await backupd.restores.create({
  backupId,
  target: { kind: "custom", connectionString: process.env.STAGING_URL! },
  replaceExisting: true,
});
await backupd.restores.wait(restore);
```

## Effect API

```ts
import { Backupd } from "@backupd/sdk/effect";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const backupd = yield* Backupd;
  const { backupId } = yield* backupd.backups.trigger("db_123");
  return yield* backupd.backups.wait(backupId);
}).pipe(Effect.catchTag("OperationFailed", (e) => Effect.logError(e.message)));

await Effect.runPromise(program.pipe(Effect.provide(Backupd.layer({ workspace: "acme" }))));
```

## Decrypt on your own machine

```ts
import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { Backupd } from "@backupd/sdk";
import { openBackup, parseKeyFile } from "@backupd/sdk/local";
import { Effect } from "effect";

const file = await backupd.backups.download(backupId, { raw: true }); // as stored: .zst.age
const keys = await Effect.runPromise(parseKeyFile(await readFile("backupd-laptop.agekey", "utf8")));
const dump = await Effect.runPromise(openBackup(file.stream, keys));
await dump.pipeTo(Writable.toWeb(createWriteStream("app.pgdump")));
```

## Reference

|                                                                                                                                              |                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `account.me()`                                                                                                                               | The key's user.           |
| `workspaces.list()` / `current()` / `find(ref)`                                                                                              | Workspaces you belong to. |
| `databases.list()` / `get(id)` / `create(input)` / `testConnection(conn)` / `pause(id)` / `resume(id)` / `remove(id)`                        | Databases.                |
| `backups.trigger(dbId)` / `wait(id, opts)` / `get(id)` / `list(opts)` / `latest(dbId)` / `download(id, opts)` / `cancel(id)` / `quota(dbId)` | Backups.                  |
| `restores.create(input)` / `wait(handle, opts)` / `get(handle)` / `list(dbId)` / `cancel(id)`                                                | Restores.                 |
| `keys.list()` / `add({ recipient, label })` / `revoke(id)`                                                                                   | Encryption keys.          |

Errors: `ApiError` (`status`, `code`), `ConfigError`, `NetworkError`, `ResponseError`, `OperationFailed`, `WaitTimeout`, `LocalError`. Rate-limited calls are retried automatically.

Docs: [docs.backupd.dev/docs/sdk](https://docs.backupd.dev/docs/sdk). MIT licensed.
