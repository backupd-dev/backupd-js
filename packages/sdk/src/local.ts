/**
 * Work with backups on your own machine, without backupd: create an age key,
 * decrypt a downloaded backup with it, and decompress it. Every backupd backup
 * is zstd-compressed and then age-encrypted to the workspace's keys, so a key
 * you added in Settings → Encryption opens it.
 *
 * Needs Node.js 22.15+ (or Bun) for built-in zstd.
 */
import { Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";

import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { Effect } from "effect";

import { LocalError } from "./errors.js";

export interface GeneratedKey {
  /** The secret key (`AGE-SECRET-KEY-1…`). Keep it; it never leaves this machine. */
  readonly identity: string;
  /** The public key (`age1…`) to add to the workspace. */
  readonly recipient: string;
}

/** Creates a new age X25519 key pair. */
export const generateKey: Effect.Effect<GeneratedKey, LocalError> = Effect.tryPromise({
  catch: (cause) => new LocalError({ cause, message: "Couldn't generate an age key." }),
  try: async () => {
    const identity = await generateX25519Identity();
    return { identity, recipient: await identityToRecipient(identity) };
  },
});

/** The public key for a secret key. */
export const recipientOf = (identity: string): Effect.Effect<string, LocalError> =>
  Effect.tryPromise({
    catch: (cause) => new LocalError({ cause, message: "That isn't a valid age secret key." }),
    try: () => identityToRecipient(identity),
  });

/**
 * A key file as written by backupd (Settings → Encryption → Create key, or
 * `backupd keys generate`) or by `age-keygen`: comment lines and one or more
 * `AGE-SECRET-KEY-1…` lines.
 */
export const formatKeyFile = (key: GeneratedKey, label: string): string =>
  [
    `# backupd key: ${label}`,
    `# created: ${new Date().toISOString()}`,
    `# public key: ${key.recipient}`,
    key.identity,
    "",
  ].join("\n");

/** The secret keys in a key file. Fails if there are none. */
export const parseKeyFile = (text: string): Effect.Effect<ReadonlyArray<string>, LocalError> => {
  const identities = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("AGE-SECRET-KEY-1"));
  return identities.length > 0
    ? Effect.succeed(identities)
    : Effect.fail(
        new LocalError({
          message: "No age secret key (AGE-SECRET-KEY-1…) found in the key file.",
        }),
      );
};

/** Decrypts an age-encrypted stream with any of the given secret keys. */
export const decrypt = (
  input: ReadableStream<Uint8Array>,
  identities: ReadonlyArray<string>,
): Effect.Effect<ReadableStream<Uint8Array>, LocalError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new LocalError({
        cause,
        message:
          "Couldn't decrypt the backup. Is it encrypted to this key? Keys added after a backup was made can't open it.",
      }),
    try: async () => {
      const decrypter = new Decrypter();
      for (const identity of identities) {
        decrypter.addIdentity(identity);
      }
      return (await decrypter.decrypt(input)) as ReadableStream<Uint8Array>;
    },
  });

/** Decompresses a zstd stream. */
export const decompress = (input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Node's web stream types differ only nominally.
  const source = Readable.fromWeb(input as Parameters<typeof Readable.fromWeb>[0]);
  return Readable.toWeb(
    source.pipe(createZstdDecompress()),
  ) as unknown as ReadableStream<Uint8Array>;
};

/**
 * Decrypts and decompresses a backup as stored (`.zst.age`), giving the
 * engine's own dump: a pg_dump archive, a SQL file, a mongodump archive or a
 * Convex snapshot zip.
 */
export const openBackup = (
  input: ReadableStream<Uint8Array>,
  identities: ReadonlyArray<string>,
): Effect.Effect<ReadableStream<Uint8Array>, LocalError> =>
  Effect.map(decrypt(input, identities), decompress);
