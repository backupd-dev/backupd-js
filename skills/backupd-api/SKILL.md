---
name: backupd-api
description: "Call the backupd HTTP API directly with curl or from any language (Python, Go, Ruby and others): authentication with the x-api-key header, the POST-per-action endpoint shape, triggering and polling backups, downloading backups, error codes and rate limits. Use when the user wants to integrate backupd without the CLI or TypeScript SDK, generate a client from its OpenAPI spec, or debug raw API calls."
---

# backupd HTTP API

Use this skill when the CLI (backupd-cli) and the TypeScript SDK (backupd-sdk) don't fit. Both wrap this API and handle workspaces, polling and retries for you, so recommend them first for shell or TypeScript work.

- Reference: https://api.backupd.dev/api-reference
- OpenAPI: https://api.backupd.dev/api-reference/spec.json. Generate clients from it, and check request and response shapes against it rather than guessing.
- Guide: https://docs.backupd.dev/docs/api

## Shape of a request

Every action is a `POST` with a JSON body to `https://api.backupd.dev/api-reference/<area>/<action>`, with the key in `x-api-key`:

```sh
curl -sf -X POST https://api.backupd.dev/api-reference/databases/list \
  -H "x-api-key: $BACKUPD_API_KEY" \
  -H "content-type: application/json" \
  -d "{\"organizationId\": \"$ORG\"}"
```

- **Auth:** only the `x-api-key` header. `Authorization: Bearer` and keys in the URL are rejected. Keys start with `bkp_`, are created in **Settings → API & MCP**, and act as the user who made them, with their role in each workspace.
- **Workspace:** most bodies need `organizationId` (the workspace ID), and database calls need `databaseId`. Both are in the console under a database's **Settings → Identifiers**, or come from `databases/list`.
- Read the key from the environment or a secret store. Never inline it in code, commands you show, or logs.

## Back up and wait

```sh
BACKUP_ID=$(curl -sf -X POST "$API/api-reference/backups/trigger" \
  -H "x-api-key: $BACKUPD_API_KEY" -H "content-type: application/json" \
  -d "{\"organizationId\": \"$ORG\", \"databaseId\": \"$DB\"}" | jq -r .backupId)

while true; do
  STATUS=$(curl -sf -X POST "$API/api-reference/backups/get" \
    -H "x-api-key: $BACKUPD_API_KEY" -H "content-type: application/json" \
    -d "{\"organizationId\": \"$ORG\", \"backupId\": \"$BACKUP_ID\"}" | jq -r .status)
  case "$STATUS" in
    succeeded) break ;;
    failed|cancelled) exit 1 ;;
  esac
  sleep 15
done
```

- `trigger` uses one of the plan's manual backups for that database per rolling 24 hours (2 on Starter, 5 on Pro). Never retry it automatically on `429`, and never call it in a loop.
- Poll every 10–30 seconds. Status goes `queued` → `running` → `succeeded`, `failed` or `cancelled`. Afterwards, `verificationStatus` moves to `verified` or `failed` once the restore test runs.

## Download

```sh
# Decrypted dump in its native format
curl -fOJ "$API/downloads/backups/$BACKUP_ID?organizationId=$ORG" -H "x-api-key: $BACKUPD_API_KEY"

# As stored (age-encrypted, zstd-compressed). Supports ranges, so resume with -C -
curl -f -C - -o backup.zst.age "$API/downloads/backups/$BACKUP_ID?organizationId=$ORG&raw=1" \
  -H "x-api-key: $BACKUPD_API_KEY"
age -d -i key.agekey backup.zst.age | zstd -d > backup.dump
```

Downloads are `GET`s on `/downloads/…`, not `/api-reference`. They need the download permission and are recorded in the audit log. The file is production data, so don't print it.

## Errors

The body is `{ code, status, message }`:

| Status | Code                | Do                                                                                                                                                                              |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`       | Fix the body. The response lists the fields that failed.                                                                                                                        |
| 401    | `UNAUTHORIZED`      | The key is missing, wrong, revoked or expired. Tell the user and don't retry.                                                                                                   |
| 403    | `FORBIDDEN`         | The role doesn't allow it, or the plan doesn't include it. Tell the user.                                                                                                       |
| 404    | `NOT_FOUND`         | Wrong ID or workspace, or the user isn't a member.                                                                                                                              |
| 409    | `CONFLICT`          | Busy, for example a backup is already running. Wait for that one.                                                                                                               |
| 429    | `TOO_MANY_REQUESTS` | Either the rate limit (120 per minute per key, so back off and honour `Retry-After`) or no manual backups left today (the message says when the next frees up, so don't retry). |

## Restores and destructive calls

Restores, deleting backups and removing databases change data. Before writing code or running a request that does any of them, say exactly what it will overwrite or delete and get the user's confirmation. A restore over the original database requires its exact name in the body. Get that name from the user; don't fill it in from `databases/list`. See the backupd-restore skill.

## MCP

For interactive use from Claude, Cursor and similar clients, backupd has an MCP server with OAuth sign-in, so no key is needed. The user adds it from **Settings → API & MCP**, for example `claude mcp add --transport http backupd <MCP URL>`. Destructive MCP tools are off unless a workspace owner enables them. Docs: https://docs.backupd.dev/docs/api-and-mcp
