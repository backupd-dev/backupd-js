---
name: backupd-restore
description: "Restore backupd backups safely, into another database, over the original, or on the user's own machine with their own age key, and decrypt backups without backupd using age, zstd and pg_restore, mysql or mongorestore. Use when the user wants to restore, recover, roll back, refresh staging, inspect a dump, or open a `.zst.age` backup file from backupd."
---

# Restoring backupd backups

A restore writes over data. Work through these steps in order and don't skip the confirmations. Docs: https://docs.backupd.dev/docs/restoring

## 1. Pick the backup

```sh
backupd backup list --db <db> --limit 10 --json
backupd backup get <id> --json
```

Use a backup with `status: "succeeded"` and `hasFile: true`. Prefer one with `verificationStatus: "verified"` and `verificationLevel: "restore"`, which means backupd restored it in a sandbox and compared it. If the user said "latest", `latest --db <db>` picks the newest succeeded backup that has a file. Tell them which backup that is (its ID and `startedAt`) before you go on.

## 2. Pick where it goes

| Where                              | How                                                      | Risk                                           |
| ---------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| A local or scratch database        | `--local --key <file> --to <url>` (runs on this machine) | Lowest. Prefer it for inspecting or debugging. |
| Another database backupd can reach | `--to <url>` (runs on backupd's machines)                | Overwrites the target if `--replace` is set.   |
| The original database              | `--to-original --confirm <exact name>`                   | Overwrites production.                         |

Before **any** restore, tell the user:

- which backup it is and when it was taken,
- which database will be written to,
- whether existing tables will be dropped (`--replace`),

then wait for an explicit yes. For `--to-original`, the user must give you the database name to confirm. Don't fill it in yourself.

## 3. Restore

### Into another database (on backupd)

```sh
backupd restore <backup-id> --to "$TARGET_URL" --wait --json
backupd restore latest --db app-prod --to "$STAGING_URL" --replace --wait --json
```

The target must accept TLS connections from the internet, because backupd connects to it. Without `--replace`, tables that already exist in the target cause errors. The result reports `tablesRestored` and `rowsRestored`.

### Over the original

```sh
backupd restore <backup-id> --to-original --confirm <database-name> --wait --json
```

Only when the user asked for it in so many words, such as "roll production back". Suggest they take a fresh backup first (`backupd backup now <db> --wait`) so the current state can be recovered.

### On this machine, with the user's own key

backupd never decrypts the backup. The CLI downloads the encrypted file, decrypts and decompresses it while streaming, and pipes it into the engine's tool.

```sh
backupd restore latest --db app-prod --local --key backupd-laptop.agekey --to "$LOCAL_URL"
```

- Needs `pg_restore`, `mysql` or `mongorestore` on `PATH`.
- The key can be in `BACKUPD_AGE_KEY` instead of `--key`.
- A key only opens backups made **after** it was added to the workspace. "Couldn't decrypt" usually means the backup is older than the key. Pick a newer backup, or download a decrypted copy with `backupd backup download <id>`.
- PostgreSQL servers older than 17 and MongoDB backups that need `--oplogReplay` don't work with `--local`. Use the manual commands below.
- For Convex, `--local` prints the steps instead of running them.

If the user has no key yet: `backupd keys generate --label <label>` writes the secret key to a file and uploads only the public key. That needs the owner or admin role. Only backups made after this open with the key, so they may need `backupd backup now <db> --wait` first. Tell them to keep the key file in a password manager or vault, because backupd can't recover it.

### Cancel

```sh
backupd restores cancel <restore-id>
```

Tables already restored stay as they are.

## Just get the dump

```sh
backupd backup download latest --db app-prod -o app.pgdump                  # decrypted by backupd
backupd backup download latest --db app-prod --key backupd-laptop.agekey    # decrypted here
backupd backup download latest --db app-prod --raw                          # as stored: .zst.age
```

Files are written readable only by the user. They contain production data, so don't print their contents, and suggest deleting them when done.

## Without backupd: age, zstd and the engine's tools

This works with no backupd account, given the `.zst.age` file and a key from the workspace's **Settings → Encryption**:

```sh
# PostgreSQL 17 and later
age -d -i backupd.agekey app.pgdump.zst.age | zstd -d \
  | pg_restore --no-owner --single-transaction -d "$TARGET_URL"

# PostgreSQL 9.2 to 16: backups use pg_dump 18, which sets transaction_timeout; filter it out
age -d -i backupd.agekey app.pgdump.zst.age | zstd -d \
  | pg_restore --no-owner -f - | grep -v '^SET transaction_timeout' \
  | psql --single-transaction -v ON_ERROR_STOP=1 "$TARGET_URL"

# MySQL / MariaDB (put credentials in an option file, not on the command line)
age -d -i backupd.agekey app.sql.zst.age | zstd -d | mysql --defaults-extra-file=target.cnf target_db

# MongoDB (add --oplogReplay for full-instance backups)
age -d -i backupd.agekey app.archive.zst.age | zstd -d | mongorestore --archive --uri "$TARGET_URI"

# Convex
age -d -i backupd.agekey app.zip.zst.age | zstd -d > snapshot.zip
npx convex import --replace-all snapshot.zip
```

Check the download first: `sha256sum <file>` should match the checksum on the backup's page (`checksum` in `backup get --json`).

## Never

- Print, log or paste an age secret key (`AGE-SECRET-KEY-1…`) or the contents of a `.agekey` file.
- Restore over a database the user didn't name.
- Use `--replace` or `--to-original` without saying so first.
- Start a second restore because the first timed out (exit code `4`). Check `backupd restores list --db <db> --json` first.
