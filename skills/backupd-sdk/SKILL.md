---
name: backupd-sdk
description: "Write TypeScript that uses the backupd SDK (`@backupd/sdk`, `@backupd/sdk/effect`, `@backupd/sdk/local`) to list databases, trigger and wait for backups, start restores, download backups and decrypt them with an age key. Covers the Promise and Effect APIs, typed errors, waiters and rate limits. Use when code imports `@backupd/sdk` or the user wants to automate backupd from Node.js, Bun or an Effect program."
---

# backupd TypeScript SDK

`@backupd/sdk` wraps backupd's HTTP API. It works out the workspace, waits for backups and restores to finish, retries when rate limited, and has typed errors. The CLI is built on it. Docs: https://docs.backupd.dev/docs/sdk. Full method list: [references/api.md](references/api.md).

```sh
npm i @backupd/sdk          # Promise API
npm i @backupd/sdk effect   # also for @backupd/sdk/effect and @backupd/sdk/local
```

It runs on Node.js 22.15+ or Bun. **Server-side only:** it needs an API key, which must never be bundled into browser code. Don't use it in client components, frontend bundles or anything that ships to users.

## Client

```ts
import { Backupd } from "@backupd/sdk";

const backupd = new Backupd(); // reads BACKUPD_API_KEY, BACKUPD_WORKSPACE, BACKUPD_API_URL
```

Options, all optional: `apiKey`, `workspace` (slug or ID), `baseUrl`, `fetch`, `userAgent`. Read the key from the environment or a secret manager. Never hard-code it.

A client works in one workspace: the `workspace` option, then `BACKUPD_WORKSPACE`, then the key's only workspace. Otherwise calls fail with `ConfigError`. Create one client per workspace.

Methods take **IDs**, not names. Resolve names with `databases.list()`:

```ts
const db = (await backupd.databases.list()).find((d) => d.name === "app-prod");
if (!db) throw new Error("No database named app-prod");
```

## Back up and wait

```ts
import { Backupd, OperationFailed, WaitTimeout } from "@backupd/sdk";

const { backupId, quota } = await backupd.backups.trigger(db.id);
try {
  const backup = await backupd.backups.wait(backupId, {
    timeout: "30 minutes",
    onProgress: (b) => console.error(b.status, b.phase),
  });
  // backup.verificationStatus: "unverified" | "verifying" | "verified" | "failed"
} catch (error) {
  if (error instanceof OperationFailed) {
    // the backup failed or was cancelled; error.message is why
  } else if (error instanceof WaitTimeout) {
    // still running; don't trigger another, check later with backups.get(backupId)
  }
  throw error;
}
```

`trigger` uses one of the plan's manual backups for that database per rolling 24 hours (2 on Starter, 5 on Pro). Check `backups.quota(db.id)` first, and never call it in a loop or a retry. `ApiError` `409` means a backup is already running; `429` means rate limited or no manual backups left.

## Restore

```ts
const handle = await backupd.restores.create({
  backupId,
  target: { kind: "custom", connectionString: process.env.STAGING_URL! },
  replaceExisting: true, // drops and replaces existing tables
});
const run = await backupd.restores.wait(handle);
```

`target: { kind: "original", confirmName: "<exact database name>" }` overwrites the source database. Only write code that does this when the user explicitly asks for it, and never derive `confirmName` from `db.name` automatically: that defeats the confirmation. Restores need the owner or admin role.

## Download and decrypt

```ts
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { openBackup, parseKeyFile } from "@backupd/sdk/local";
import { Effect } from "effect";

const latest = await backupd.backups.latest(db.id);

// Decrypted by backupd:
const plain = await backupd.backups.download(latest.id);

// Or as stored, decrypted locally with the user's age key:
const raw = await backupd.backups.download(latest.id, { raw: true });
const keys = await Effect.runPromise(parseKeyFile(await readFile(keyPath, "utf8")));
const dump = await Effect.runPromise(openBackup(raw.stream, keys));
await dump.pipeTo(Writable.toWeb(createWriteStream("app.pgdump", { mode: 0o600 })));
```

A key opens only backups made after it was added. Older ones fail with `LocalError`. To create a key, `generateKey` (an Effect, not a function) and `formatKeyFile`, then `backupd.keys.add({ recipient, label })`. Write the secret key file with mode `0o600` **before** adding the public key.

## Effect API

```ts
import { Backupd } from "@backupd/sdk/effect";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const backupd = yield* Backupd;
  const { backupId } = yield* backupd.backups.trigger("db_123");
  return yield* backupd.backups.wait(backupId, { timeout: "30 minutes" });
}).pipe(
  Effect.catchTag("OperationFailed", (e) => Effect.logError(e.message)),
  Effect.catchTag("WaitTimeout", (e) => Effect.logWarning(e.message)),
);

await Effect.runPromise(program.pipe(Effect.provide(Backupd.layer())));
```

It's built on **Effect 4**, so use Effect 4 APIs. The methods are the same as the Promise API, but `account.me`, `workspaces.list` and `workspaces.current` are Effects: `yield* backupd.workspaces.list`, not `list()`. Use `makeClient(options)` to build a client without a layer. Response schemas are exported as `Schemas`.

## Errors

Every error has a `_tag`: `ApiError` (`status`, `code`, `retryAfter?`), `ConfigError`, `NetworkError`, `ResponseError`, and from waiters `OperationFailed` and `WaitTimeout`, plus `LocalError` from `/local`. `isAuthError(e)` is true for a `401`. Handle `401`/`403` by reporting to the user rather than retrying.

## Rate limits

120 requests per minute per key. The SDK already retries `429`s that have a `Retry-After` of 60 seconds or less, up to three times, so don't add your own retry loop around it. Waiters poll every 3 seconds; set `interval: "10 seconds"` or more when waiting on many operations at once.
