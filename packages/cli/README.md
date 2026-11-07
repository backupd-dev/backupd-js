# @backupd/cli

The [backupd](https://backupd.dev) CLI: back up, restore and manage your databases from the terminal and CI.

```sh
npx @backupd/cli login
```

Or install it: `npm i -g @backupd/cli` (the command is `backupd`), or a standalone binary with `curl -fsSL https://backupd.dev/install | sh`.

## Commands

| Command                                                                |                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `backupd login` / `logout` / `whoami`                                  | Sign in through the browser; the CLI saves an API key named after this machine. |
| `backupd workspace list` / `use <slug>`                                | Pick the workspace commands run in.                                             |
| `backupd db list` / `get` / `add` / `test` / `pause` / `resume` / `rm` | Manage databases.                                                               |
| `backupd backup now <db> [--wait]`                                     | Back up now. With `--wait`, exits non-zero if it fails.                         |
| `backupd backup list` / `get` / `download` / `cancel` / `quota`        | Inspect and download backups.                                                   |
| `backupd restore <backup> --to <url> [--wait]`                         | Restore into another database.                                                  |
| `backupd restore <backup> --to-original --confirm <name>`              | Overwrite the original database.                                                |
| `backupd restore <backup> --local --key <file> --to <url>`             | Decrypt on this machine and run `pg_restore`, `mysql` or `mongorestore`.        |
| `backupd restores list` / `cancel`                                     | Follow restores.                                                                |
| `backupd keys list` / `generate` / `add` / `revoke`                    | Manage the encryption keys you hold.                                            |
| `backupd status [--max-age 26]`                                        | Exits 1 if any database lacks a recent successful backup.                       |

`backup` and `restore` accept `latest --db <name>` in place of a backup ID.

Every command takes `--json` (results on stdout, messages on stderr), `--workspace <slug>` and `--api-key <key>`.

## Environment

| Variable             |                                                        |
| -------------------- | ------------------------------------------------------ |
| `BACKUPD_API_KEY`    | API key, for CI. Overrides the saved login.            |
| `BACKUPD_WORKSPACE`  | Workspace slug or ID.                                  |
| `BACKUPD_AGE_KEY`    | Your age secret key, instead of `--key <file>`.        |
| `BACKUPD_CONFIG_DIR` | Where to keep the login (default `~/.config/backupd`). |

## Exit codes

`0` success · `1` failed · `2` usage error · `3` not logged in or not allowed · `4` timed out waiting.

Docs: [docs.backupd.dev/docs/cli](https://docs.backupd.dev/docs/cli). MIT licensed.
