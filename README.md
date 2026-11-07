<p align="center">
  <a href="https://backupd.dev"><img src="https://backupd.dev/brand/backupd-mark.png" width="72" height="72" alt="backupd"></a>
</p>

<h1 align="center">backupd CLI and SDK</h1>

<p align="center">
  Back up, restore and manage your <a href="https://backupd.dev">backupd</a> databases from the terminal, CI and code.
</p>

| Package                        | What it is                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------ |
| [`@backupd/cli`](packages/cli) | The CLI, `backupd`. `npx @backupd/cli`, or a standalone binary.                |
| [`@backupd/sdk`](packages/sdk) | TypeScript SDK with a Promise API and an [Effect](https://effect.website) API. |

## CLI

```sh
curl -fsSL https://backupd.dev/install | sh      # macOS, Linux
irm https://backupd.dev/install.ps1 | iex        # Windows (PowerShell)
npm i -g @backupd/cli                            # anywhere with Node.js 22.15+
backupd login
backupd db list
backupd backup now app-prod --wait
backupd restore latest --db app-prod --to "$STAGING_URL" --wait
```

Restore without backupd, decrypting on your own machine:

```sh
backupd keys generate --label laptop      # secret key stays here; only the public key is uploaded
backupd restore latest --db app-prod --local --key backupd-laptop.agekey --to "$LOCAL_URL"
```

In CI, set `BACKUPD_API_KEY` (create one in Settings → API & MCP) and `BACKUPD_WORKSPACE`:

```yaml
- run: npx @backupd/cli backup now app-prod --wait # before running migrations
- run: npx @backupd/cli status --max-age 26 # fails if any database has no recent backup
```

Full reference: [docs.backupd.dev/docs/cli](https://docs.backupd.dev/docs/cli).

## SDK

```ts
import { Backupd } from "@backupd/sdk";

const backupd = new Backupd({ apiKey: process.env.BACKUPD_API_KEY, workspace: "acme" });

const { backupId } = await backupd.backups.trigger("db_123");
const backup = await backupd.backups.wait(backupId);
console.log(backup.verificationStatus); // "verified" once its restore test passed
```

With Effect:

```ts
import { Backupd } from "@backupd/sdk/effect";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const backupd = yield* Backupd;
  const { backupId } = yield* backupd.backups.trigger("db_123");
  return yield* backupd.backups.wait(backupId);
});

await Effect.runPromise(program.pipe(Effect.provide(Backupd.layer())));
```

Full reference: [docs.backupd.dev/docs/sdk](https://docs.backupd.dev/docs/sdk).

## Development

Needs [Bun](https://bun.sh) 1.4+ and Node.js 22.15+.

```sh
bun install
bun run test          # unit tests and end-to-end CLI tests against a fake API
bun run check-types
bun run lint
bun packages/cli/src/bin.ts --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
