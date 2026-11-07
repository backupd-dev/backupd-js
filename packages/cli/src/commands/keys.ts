import { ConfigError, LocalError } from "@backupd/sdk/effect";
import { formatKeyFile, generateKey, recipientOf } from "@backupd/sdk/local";
import { Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { Json, client } from "../context.js";
import * as out from "../output.js";

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const api = yield* client;
    const keys = yield* api.keys.list();
    if (yield* Json) {
      yield* out.json(keys);
      return;
    }
    yield* out.table(
      keys.recipients,
      [
        { header: "Label", value: (k) => out.bold(k.label) },
        { header: "Fingerprint", value: (k) => k.fingerprint },
        { header: "Public key", value: (k) => out.dim(`${k.recipient.slice(0, 20)}…`) },
        { header: "Added", value: (k) => out.ago(k.createdAt) },
      ],
      "No keys of your own yet. Backups can only be opened through backupd. Add one with `backupd keys generate`.",
    );
    yield* out.note(
      out.dim(
        `${keys.recipients.length} of ${keys.maxRecipients} keys. backupd's own key: ${keys.serviceRecipient.slice(0, 20)}…`,
      ),
    );
  }),
).pipe(Command.withDescription("List the keys new backups are encrypted to."));

const generate = Command.make(
  "generate",
  {
    label: Flag.String("label").pipe(
      Flag.withDescription("A name for the key, e.g. laptop or ops-vault."),
    ),
    output: Flag.String("output").pipe(
      Flag.withAlias("o"),
      Flag.withDescription("Where to save the secret key. Default: backupd-<label>.agekey"),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = Option.getOrElse(
        flags.output,
        () => `backupd-${flags.label.replaceAll(/[^\w.-]/gu, "_")}.agekey`,
      );
      if (yield* fs.exists(path)) {
        return yield* Effect.fail(
          new ConfigError({ message: `${path} already exists; not overwriting it.` }),
        );
      }
      const api = yield* client;
      // Check the API and the key limit first, so a failure never leaves a
      // secret key on disk that was never added.
      const existing = yield* api.keys.list();
      if (existing.recipients.length >= existing.maxRecipients) {
        return yield* Effect.fail(
          new ConfigError({
            message: `This workspace already has ${existing.maxRecipients} keys, the most it can hold. Revoke one first.`,
          }),
        );
      }
      const key = yield* generateKey;
      // Save the secret before telling the API, so it can never be lost.
      yield* fs
        .writeFileString(path, formatKeyFile(key, flags.label), { mode: 0o600 })
        .pipe(
          Effect.mapError((cause) => new LocalError({ cause, message: `Couldn't write ${path}.` })),
        );
      const added = yield* api.keys.add({ label: flags.label, recipient: key.recipient });
      yield* out.either(
        yield* Json,
        { fingerprint: added.fingerprint, id: added.id, path, recipient: key.recipient },
        Effect.andThen(
          out.success(
            `Added key ${out.bold(flags.label)} (${added.fingerprint}). Secret key saved to ${out.bold(path)}.`,
          ),
          out.note(
            "New backups are encrypted to it from now on. Keep the file somewhere safe: backupd never sees it, and it can't be recovered.",
          ),
        ),
      );
    }),
).pipe(
  Command.withDescription(
    "Create an age key on this machine and add its public half to the workspace.",
  ),
);

const add = Command.make(
  "add",
  {
    label: Flag.String("label").pipe(Flag.withDescription("A name for the key.")),
    recipient: Argument.String("key").pipe(
      Argument.withDescription("A public key (age1…), or a secret key file to take it from."),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const api = yield* client;
      let recipient = flags.recipient;
      if (!recipient.startsWith("age1")) {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs
          .readFileString(recipient)
          .pipe(
            Effect.mapError(
              () => new ConfigError({ message: "Pass an age1… public key or a key file." }),
            ),
          );
        const secret = text.split(/\r?\n/u).find((line) => line.startsWith("AGE-SECRET-KEY-1"));
        if (!secret) {
          return yield* Effect.fail(
            new ConfigError({ message: `No age secret key in ${recipient}.` }),
          );
        }
        recipient = yield* recipientOf(secret.trim());
      }
      const added = yield* api.keys.add({ label: flags.label, recipient });
      yield* out.either(
        yield* Json,
        added,
        out.success(`Added ${flags.label} (${added.fingerprint}).`),
      );
    }),
).pipe(Command.withDescription("Add a public key you already have."));

const revoke = Command.make(
  "revoke",
  { key: Argument.String("key").pipe(Argument.withDescription("Fingerprint, ID or label.")) },
  ({ key }) =>
    Effect.gen(function* () {
      const api = yield* client;
      const { recipients } = yield* api.keys.list();
      const found = recipients.find(
        (k) => k.id === key || k.fingerprint === key || k.label === key,
      );
      if (!found) {
        return yield* Effect.fail(
          new ConfigError({ message: `No key "${key}". See \`backupd keys list\`.` }),
        );
      }
      yield* api.keys.revoke(found.id);
      yield* out.success(
        `Revoked ${found.label}. Backups made before now can still be opened with it.`,
      );
    }),
).pipe(Command.withDescription("Stop encrypting new backups to a key."));

export const keys = Command.make("keys").pipe(
  Command.withDescription("Manage the encryption keys you hold (restore without backupd)."),
  Command.withSubcommands([list, generate, add, revoke]),
);
