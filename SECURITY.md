# Security

Please report vulnerabilities privately to **security@backupd.dev**, not in a public issue. We'll reply within two working days.

How the CLI handles secrets:

- `backupd login` saves one API key to `~/.config/backupd/config.json` with owner-only permissions (0600). `backupd logout` revokes it.
- Keys made by `backupd keys generate` never leave your machine; only the public key is sent to backupd.
- Backups opened with `--key` or `--local` are decrypted on your machine. The API key is never sent to the storage host a raw download redirects to.
