# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```sh
bun install
bun run test
bun run check-types
bun run lint
bun run format
```

The CLI's end-to-end tests run the real CLI against a fake API (`packages/cli/test/cli.test.ts`); add a case there for new commands.

The SDK talks only to backupd's public API, described at https://api.backupd.dev/api-reference. Response shapes live in `packages/sdk/src/schemas.ts` and list only the fields the SDK uses.

## Releasing (maintainers)

1. Bump `version` in `packages/sdk/package.json`, `packages/cli/package.json`, `packages/cli/src/version.ts` and `SDK_VERSION` in `packages/sdk/src/client.ts`.
2. `bun run check-types && bun run test && bun run build`
3. Publish to npm, SDK first. Use `bun publish`, which rewrites the CLI's `workspace:*` dependency; npm then asks for your passkey or 2FA code in the browser:
   ```sh
   cd packages/sdk && bun publish
   cd ../cli && bun publish
   ```
   Both packages belong to the `backupd` npm organisation: `@backupd/sdk` and `@backupd/cli` (whose command is `backupd`).
4. Tag and push: `git tag v0.1.0 && git push --tags`. The Release workflow builds the standalone binaries and attaches them to a GitHub release; https://backupd.dev/install downloads from the latest release.
