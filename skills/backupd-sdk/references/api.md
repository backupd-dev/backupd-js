# @backupd/sdk method reference

Promise signatures. In `@backupd/sdk/effect` each returns `Effect<Result, BackupdError>`, and `account.me`, `workspaces.list` and `workspaces.current` are Effects rather than functions. Timestamps are ISO 8601 strings. Source of truth: https://docs.backupd.dev/docs/sdk/reference

## Account and workspaces

| Method                 | Returns                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `account.me()`         | `{ id, name, email }`                                                                    |
| `workspaces.list()`    | `{ id, slug, name, role, region? }[]`                                                    |
| `workspaces.current()` | The client's workspace                                                                   |
| `workspaces.find(ref)` | Workspace by slug or ID. With `undefined`, the only workspace. Fails with `ConfigError`. |

## Databases

| Method                                                                           | Returns                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `databases.list()`                                                               | `Database[]`: `id`, `name`, `host`, `engine` (`postgres`, `mysql`, `mongodb`, `convex`), `engineVersion`, `status` (`active`, `paused`), `schedule` (`6h`, `12h`, `24h`), `scheduleHour`, `retentionDays`, `lastBackup { status, verificationStatus, startedAt }`, `lastBackupAt`, `fileCount`, `verifiedCount`, `totalBytes` |
| `databases.get(id)`                                                              | Plus `nextRunAt`, `effectiveSchedule`, `canManage`, `lastBackup.id`, `stats { fileCount, totalBytes, avgDurationMs, successRate, verifiedRate }`                                                                                                                                                                              |
| `databases.create({ name, connection, schedule, scheduleHour?, retentionDays })` | `{ id, name, nextRunAt }`                                                                                                                                                                                                                                                                                                     |
| `databases.testConnection(connection)`                                           | `{ ok: true, probe: { engineVersion, sizeBytes } }` or `{ ok: false, code, message, retryable }`. Never throws for a bad connection.                                                                                                                                                                                          |
| `databases.pause(id)`, `databases.resume(id)`                                    | `{ ok, name }`                                                                                                                                                                                                                                                                                                                |
| `databases.remove(id)`                                                           | `{ ok, name }`. Refused while stored backups exist.                                                                                                                                                                                                                                                                           |

```ts
type Connection =
  | { engine: "postgres" | "mysql" | "mongodb"; connectionString: string }
  | { engine: "convex"; deploymentUrl: string; deployKey: string; selfHosted?: boolean };
```

## Backups

| Method                                                         | Returns                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `backups.trigger(databaseId)`                                  | `{ backupId, databaseName, quota: { remaining, resetAt } }`. Uses a manual backup.                            |
| `backups.wait(backupId, { timeout?, interval?, onProgress? })` | Finished `Backup`. Fails with `OperationFailed` or `WaitTimeout`. Defaults: 6 hours, 3 seconds.               |
| `backups.get(backupId)`                                        | `Backup` (below)                                                                                              |
| `backups.list({ databaseId?, deleted?, limit?, offset? })`     | `{ items: BackupSummary[], total }`, newest first. `limit` 1–100, default 50.                                 |
| `backups.latest(databaseId)`                                   | Newest succeeded backup with a file, among the last 25. `ApiError 404` if none.                               |
| `backups.download(backupId, { raw? })`                         | `{ fileName, stream: ReadableStream<Uint8Array>, size }`. Decrypted by default; `raw: true` gives `.zst.age`. |
| `backups.cancel(backupId)`                                     | `{ databaseName, fileName }`                                                                                  |
| `backups.quota(databaseId)`                                    | `{ limit, remaining, resetAt }`                                                                               |
| `backups.recover(backupIds)`                                   | Brings backups back from Recently deleted.                                                                    |

`Backup` fields: `id`, `databaseId`, `fileName`, `status` (`queued`, `running`, `succeeded`, `failed`, `cancelled`), `phase`, `trigger` (`scheduled`, `manual`), `startedAt`, `finishedAt`, `durationMs`, `sizeBytes`, `plaintextSizeBytes`, `hasFile`, `checksum`, `format` (`pg_custom`, `mysql_sql`, `mongo_archive`, …), `errorMessage`, `verificationStatus` (`unverified`, `verifying`, `verified`, `failed`), `verificationLevel` (`integrity`, `restore`), `verifiedAt`, `verifiedAgainst`, `verificationDetails { tablesChecked, rowsChecked, sandbox, durationMs, mismatches }`, `database { id, name, engine, engineVersion, host }`, `encryption { algorithm, recipients }`, `restores`, `deletedAt`.

## Restores

| Method                                                    | Returns                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `restores.create({ backupId, target, replaceExisting? })` | `{ restoreId, backupId }`. `target` is `{ kind: "custom", connectionString }` or `{ kind: "original", confirmName }`. |
| `restores.wait(handle, options?)`                         | Finished `RestoreRun`. Fails with `OperationFailed` or `WaitTimeout`.                                                 |
| `restores.get(handle)`                                    | `{ id, status, target, targetLabel, tablesRestored, rowsRestored, error, createdAt, finishedAt }`                     |
| `restores.list(databaseId)`                               | Recent restores, plus `backupId` and `fileName`                                                                       |
| `restores.cancel(restoreId)`                              | `{ ok }`                                                                                                              |

## Encryption keys

| Method                           | Returns                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `keys.list()`                    | `{ recipients: { id, label, recipient, fingerprint, createdAt }[], maxRecipients, serviceRecipient, canManage }` |
| `keys.add({ recipient, label })` | `{ id, fingerprint }`. `recipient` is an `age1…` public key.                                                     |
| `keys.revoke(recipientId)`       | `{ fingerprint, label }`. Older backups still open with the key.                                                 |

## @backupd/sdk/local

| Export                           | Type                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| `generateKey`                    | `Effect<{ identity, recipient }, LocalError>`. An Effect, run it as is.    |
| `formatKeyFile(key, label)`      | `string`, a key file that `age -d -i` also reads                           |
| `parseKeyFile(text)`             | `Effect<string[], LocalError>`, the `AGE-SECRET-KEY-1…` lines              |
| `recipientOf(identity)`          | `Effect<string, LocalError>`                                               |
| `decrypt(stream, identities)`    | `Effect<ReadableStream, LocalError>`, still zstd-compressed                |
| `decompress(stream)`             | `ReadableStream`, a plain function                                         |
| `openBackup(stream, identities)` | `Effect<ReadableStream, LocalError>`, which is `decrypt` then `decompress` |

## Errors

| Error             | Fields                                                  | When                                                                                                         |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ApiError`        | `status`, `code`, `message`, `operation`, `retryAfter?` | API error. `code`: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `TOO_MANY_REQUESTS`. |
| `ConfigError`     | `message`                                               | No key, or no workspace could be picked                                                                      |
| `NetworkError`    | `message`, `operation`, `cause?`                        | No response                                                                                                  |
| `ResponseError`   | `message`, `operation`                                  | Response in an unexpected shape                                                                              |
| `OperationFailed` | `kind`, `id`, `status`, `message`                       | A waiter's backup or restore failed or was cancelled                                                         |
| `WaitTimeout`     | `kind`, `id`, `message`                                 | A waiter gave up. The operation may still finish.                                                            |
| `LocalError`      | `message`, `cause?`                                     | Decrypting or decompressing failed                                                                           |

Other exports: `DEFAULT_BASE_URL`, `SDK_VERSION`, `isAuthError(error)`, and the `BackupdError` union type.
