---
name: backupd-cli
description: "Use the backupd CLI (`backupd`, npm package `@backupd/cli`) to list databases, start and check backups, download them, restore them and manage encryption keys from a terminal. Use when the user mentions backupd, `bkp_` API keys, or asks to back up, check, download or restore a Postgres, MySQL, MongoDB or Convex database that backupd manages. For CI pipelines see backupd-ci; for restores see backupd-restore."
---

# backupd CLI

backupd backs up PostgreSQL, MySQL/MariaDB, MongoDB and Convex on a schedule, encrypts every backup with age, and restore-tests backups in a sandbox. The `backupd` CLI is its terminal client. Full reference: https://docs.backupd.dev/docs/cli/commands

## Before you run anything

1. **Check it's installed:** `backupd --version`. If it isn't, use `npx @backupd/cli <command>` (Node.js 22.15+), or ask the user before installing it with `npm i -g @backupd/cli` or `curl -fsSL https://backupd.dev/install | sh`.
2. **Check auth:** `backupd whoami`. Exit code `3` means the CLI isn't signed in. Ask the user to run `backupd login` themselves. It opens a browser to approve a device code, so don't run it for them and never approve a code on their behalf. In non-interactive environments, the CLI reads `BACKUPD_API_KEY`.
3. **Check the workspace:** commands run in one workspace. It comes from `-w <slug>`, then `BACKUPD_WORKSPACE`, then the saved default, then the user's only workspace. `backupd workspace list --json` shows them.

## Always use `--json`

Add `--json` to every command you run. The result goes to stdout as JSON, and progress and messages go to stderr. Parse stdout; don't scrape the tables, which are for people.

```sh
backupd db list --json
backupd backup list --db app-prod --limit 5 --json
backupd status --json
```

Databases can be referred to by name (matched case-insensitively) or by ID everywhere.

## Common tasks

| Task                                                             | Command                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| List databases and their health                                  | `backupd db list --json`                                                         |
| One database: schedule, next run, success and restore-test rates | `backupd db get <db> --json`                                                     |
| Are all backups recent and healthy?                              | `backupd status --json` (exits 1 if any database needs attention)                |
| Back up now and wait for the result                              | `backupd backup now <db> --wait --json`                                          |
| Manual backups left today                                        | `backupd backup quota <db> --json`                                               |
| Recent backups                                                   | `backupd backup list --db <db> --limit 10 --json`                                |
| One backup, including its restore test                           | `backupd backup get <id> --json` or `backupd backup get latest --db <db> --json` |
| Download the latest backup, decrypted                            | `backupd backup download latest --db <db> -o <path>`                             |
| Cancel a running backup                                          | `backupd backup cancel <id>`                                                     |
| Test a connection without saving it                              | `backupd db test --url "$DATABASE_URL"`                                          |
| Add a database                                                   | `backupd db add --name <name> --url "$DATABASE_URL" --every 24h --keep-days 30`  |
| Pause or resume schedules                                        | `backupd db pause <db>`, `backupd db resume <db>`                                |

### Reading a backup

- `status`: `queued` → `running` → `succeeded`, `failed` or `cancelled`. `errorMessage` says why it failed.
- `verificationStatus`: `unverified`, `verifying`, `verified` or `failed`. `verificationLevel` is `integrity` (decrypted and checksummed) or `restore` (restored in a sandbox and compared). A backup only counts as proven when it's `verified` at level `restore`.
- `hasFile`: whether a stored file exists to download.

## Exit codes

| Code | Means                                                                                | What to do                                                                    |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `0`  | Success                                                                              |                                                                               |
| `1`  | The backup or restore failed, `status` found a problem, or the API returned an error | Read stderr and the JSON. Report the backup's `errorMessage`.                 |
| `2`  | Usage error: wrong flag, or a database or workspace that doesn't exist               | Check the name with `db list --json`.                                         |
| `3`  | Not signed in, key rejected, or the user's role doesn't allow it                     | Ask the user to sign in, or to have an owner or admin do it. Don't retry.     |
| `4`  | Timed out waiting                                                                    | The operation may still finish. Check with `backup get`. Don't start another. |

## Rules

- **Manual backups are rationed.** Each `backup now` uses one of the plan's manual backups for that database in a rolling 24 hours (2 on Starter, 5 on Pro). Check `backup quota` first, and don't trigger backups speculatively or in loops. A `409` means one is already running: wait for it instead.
- **Ask before anything that changes or deletes data.** That means `restore` (any form), `db rm`, `db pause`, `keys revoke`, and `backup now` when it's the last one left today. Say what will happen and wait for a yes.
- **Never print, log or commit secrets:** API keys (`bkp_…`), age secret keys (`AGE-SECRET-KEY-1…`), `.agekey` files, or connection strings with passwords. Pass connection strings through environment variables such as `"$DATABASE_URL"`, not literals.
- **Downloads contain production data.** Save them only where the user asks, don't open or print their contents, and remind the user to delete them when done. Each download is recorded in the workspace's audit log.
- `db rm` refuses while the database still has stored backups. That's deliberate: don't delete backups to get around it unless the user explicitly asks.
- Restoring needs the owner or admin role, or a custom role that allows it. Exit code `3` on a restore usually means the role doesn't allow it, not that the key is wrong.

For restores, including restoring locally with the user's own key, load the backupd-restore skill.
