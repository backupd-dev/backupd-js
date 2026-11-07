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
3. Publish to npm, SDK first:
   ```sh
   cd packages/sdk && npm publish
   cd ../cli && npm publish
   ```
4. Tag and push: `git tag v0.1.0 && git push --tags`. The Release workflow builds the standalone binaries and attaches them to a GitHub release; https://backupd.dev/install downloads from the latest release.
