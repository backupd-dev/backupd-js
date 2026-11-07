---
name: backupd-ci
description: "Add backupd to CI/CD pipelines (GitHub Actions, GitLab CI and others) with the backupd CLI. Covers taking a backup before migrations and stopping the deploy if it fails, a scheduled job that fails when backups are stale or restore tests fail, and refreshing staging from the latest production backup. Use when the user wants backupd in a workflow, pipeline, deploy script or cron job."
---

# backupd in CI

In CI the backupd CLI reads its credentials from environment variables, so it never needs `backupd login`. Docs: https://docs.backupd.dev/docs/cli/ci

## Setup the user must do

You can't create these, so tell the user:

1. Create an API key in the backupd console under **Settings → API & MCP**, named after the pipeline (for example `GitHub Actions`). One key per pipeline, so each can be revoked on its own.
2. Store it as a CI **secret** named `BACKUPD_API_KEY`.
3. Store the workspace slug as `BACKUPD_WORKSPACE`. It isn't secret, so a CI variable is fine. `backupd workspace list` shows it.

A key acts as the user who created it, with their role. A pipeline that restores needs a key from an account with the restore permission (owner or admin by default).

Never put the key in the workflow file, a script or a `.env` file that's committed.

## Running the CLI

- `npx @backupd/cli <command>`, which needs Node.js 22.15+ (`actions/setup-node` with `node-version: 22`), or
- the standalone binary: `curl -fsSL https://backupd.dev/install | sh`, then add `~/.backupd/bin` to `PATH`.

## Recipes

### Back up before migrations

The backup must succeed before the schema changes. `--wait` exits non-zero on failure, so the migration step doesn't run.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      BACKUPD_API_KEY: ${{ secrets.BACKUPD_API_KEY }}
      BACKUPD_WORKSPACE: ${{ vars.BACKUPD_WORKSPACE }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Back up the database
        run: npx @backupd/cli backup now app-prod --wait --timeout 30
      - name: Run migrations
        run: npm run migrate
```

Each run uses one of the plan's manual backups for that database per rolling 24 hours (2 on Starter, 5 on Pro). Only put this on deploys that change the schema, not on every push or PR. If a backup of that database is already running, the step fails with a conflict.

### Fail when backups are stale

`backupd status` exits 1 when any database's last backup failed, its last restore test failed, it has no successful backup yet, or its last success is older than `--max-age` hours. Paused databases pass.

```yaml
on:
  schedule:
    - cron: "0 8 * * *"
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @backupd/cli status --max-age 26
        env:
          BACKUPD_API_KEY: ${{ secrets.BACKUPD_API_KEY }}
          BACKUPD_WORKSPACE: ${{ vars.BACKUPD_WORKSPACE }}
```

Set `--max-age` a little above the schedule: 26 for daily backups, 14 for every 12 hours, 8 for every 6 hours.

### Refresh staging from production

This one overwrites staging. Confirm with the user that the target really is a disposable staging database before you write it.

```yaml
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @backupd/cli restore latest --db app-prod --to "$STAGING_URL" --wait --replace
        env:
          BACKUPD_API_KEY: ${{ secrets.BACKUPD_API_KEY }}
          BACKUPD_WORKSPACE: ${{ vars.BACKUPD_WORKSPACE }}
          STAGING_URL: ${{ secrets.STAGING_URL }}
```

backupd runs the restore on its own machines, so staging must accept TLS connections from the internet (backupd has no fixed egress IPs yet). `--replace` drops and replaces tables that already exist in staging.

Never use `--to-original` in CI. Overwriting production belongs in a deliberate, human-run step.

## Exit codes

`0` success, `1` failed (or `status` found a problem), `2` usage error or unknown database, `3` key rejected or role not allowed, `4` timed out waiting (the operation may still finish).

## Scripting with JSON

`--json` prints the result on stdout and messages on stderr:

```sh
set -o pipefail
BACKUP_ID=$(npx @backupd/cli backup now app-prod --json | jq -r .backupId)
npx @backupd/cli status --json | jq -r '.checks[] | select(.ok | not) | "\(.database): \(.reason)"'
```

`status --json` still exits 1 when something needs attention. In a pipeline only the last command's exit code counts, so use `set -o pipefail`.

## Other CI systems

The same commands work anywhere. Set `BACKUPD_API_KEY` and `BACKUPD_WORKSPACE` from the system's secret store (GitLab masked variables, CircleCI contexts and so on) and call `npx @backupd/cli` or the binary.

Each key can make 120 requests per minute. `--wait` polls every few seconds, which fits easily. Give pipelines that run many commands in parallel their own key.
