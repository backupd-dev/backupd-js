import { zstdCompressSync } from "node:zlib";

import { Encrypter } from "age-encryption";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { formatKeyFile, generateKey, openBackup, parseKeyFile, recipientOf } from "../src/local.js";

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      // Several chunks, to exercise streaming.
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.slice(i, i + 7));
      }
      controller.close();
    },
  });

describe("local", () => {
  it("opens a backup made the way backupd makes them (zstd, then age)", async () => {
    const key = await Effect.runPromise(generateKey);
    const dump = new TextEncoder().encode("CREATE TABLE orders (id int);\n".repeat(500));

    const encrypter = new Encrypter();
    encrypter.addRecipient(key.recipient);
    const stored = await encrypter.encrypt(new Uint8Array(zstdCompressSync(dump)));

    const opened = await Effect.runPromise(openBackup(streamOf(stored), [key.identity]));
    expect(new Uint8Array(await new Response(opened).arrayBuffer())).toEqual(dump);
  });

  it("fails clearly with the wrong key", async () => {
    const right = await Effect.runPromise(generateKey);
    const wrong = await Effect.runPromise(generateKey);
    const encrypter = new Encrypter();
    encrypter.addRecipient(right.recipient);
    const stored = await encrypter.encrypt(
      new Uint8Array(zstdCompressSync(new Uint8Array([1, 2, 3]))),
    );

    const result = await Effect.runPromise(
      Effect.flip(openBackup(streamOf(stored), [wrong.identity])),
    );
    expect(result._tag).toBe("LocalError");
  });

  it("round-trips key files, including ones from age-keygen", async () => {
    const key = await Effect.runPromise(generateKey);
    const file = formatKeyFile(key, "laptop");
    expect(await Effect.runPromise(parseKeyFile(file))).toEqual([key.identity]);
    expect(await Effect.runPromise(recipientOf(key.identity))).toBe(key.recipient);

    const keygen = `# created: 2026-01-01T00:00:00Z\r\n# public key: ${key.recipient}\r\n${key.identity}\r\n`;
    expect(await Effect.runPromise(parseKeyFile(keygen))).toEqual([key.identity]);

    const none = await Effect.runPromise(Effect.flip(parseKeyFile("# nothing here")));
    expect(none.message).toMatch(/No age secret key/u);
  });
});
