/**
 * End-to-end tests: the real CLI, run as a subprocess against a local fake
 * of the backupd API.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { Encrypter } from "age-encryption";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "../src/bin.ts");
// Absolute, so tests can run the CLI with a PATH that hides other tools.
const BUN = execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

type Route = (
  body: Record<string, unknown>,
  req: IncomingMessage,
) => { status?: number; body?: unknown; headers?: Record<string, string>; raw?: Uint8Array };

let routes: Record<string, Route> = {};
const seen: { path: string; body: Record<string, unknown>; headers: IncomingMessage["headers"] }[] =
  [];
let baseUrl = "";
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const path = (req.url ?? "").split("?")[0] ?? "";
    seen.push({ body, headers: req.headers, path });
    const route = routes[path];
    const result = route
      ? route(body, req)
      : { body: { code: "NOT_FOUND", message: `no route ${path}`, status: 404 }, status: 404 };
    res.writeHead(result.status ?? 200, { "content-type": "application/json", ...result.headers });
    res.end(result.raw ?? (result.body === undefined ? "" : JSON.stringify(result.body)));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

let configDir = "";
let workDir = "";
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "backupd-cli-config-"));
  workDir = mkdtempSync(join(tmpdir(), "backupd-cli-work-"));
  seen.length = 0;
  routes = { ...BASE_ROUTES };
});

const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(BUN, [BIN, ...args], {
      cwd: workDir,
      env: {
        ...process.env,
        BACKUPD_API_KEY: "",
        BACKUPD_API_URL: baseUrl,
        BACKUPD_CONFIG_DIR: configDir,
        BACKUPD_WORKSPACE: "",
        NO_COLOR: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr, stdout }));
  });

const KEY = { BACKUPD_API_KEY: "bkp_test" };

const WORKSPACES = [{ id: "org_1", name: "Acme", region: "eu", role: "owner", slug: "acme" }];

const database = (overrides: Record<string, unknown> = {}) => ({
  createdAt: "2026-10-01T00:00:00.000Z",
  engine: "postgres",
  engineVersion: "16.4",
  fileCount: 3,
  host: "db.acme.dev:5432",
  id: "db_1",
  lastBackup: {
    databaseId: "db_1",
    startedAt: new Date().toISOString(),
    status: "succeeded",
    verificationStatus: "verified",
  },
  lastBackupAt: new Date(Date.now() - 3_600_000).toISOString(),
  name: "app",
  retentionDays: 30,
  schedule: "24h",
  scheduleHour: 3,
  status: "active",
  totalBytes: 612_000,
  verifiedCount: 3,
  ...overrides,
});

const backup = (overrides: Record<string, unknown> = {}) => ({
  checksum: null,
  database: {
    engine: "postgres",
    engineVersion: "16.4",
    host: "db.acme.dev:5432",
    id: "db_1",
    name: "app",
  },
  databaseId: "db_1",
  deletedAt: null,
  durationMs: 41_000,
  encryption: { algorithm: "age-v1", recipients: [] },
  errorMessage: null,
  fileName: "app_20261015T0300",
  finishedAt: null,
  format: "pg_custom",
  hasFile: true,
  id: "bk_1",
  phase: null,
  plaintextSizeBytes: 2_000_000,
  restores: [],
  sizeBytes: 612_000,
  startedAt: "2026-10-15T03:00:00.000Z",
  status: "succeeded",
  trigger: "manual",
  verificationDetails: {
    durationMs: 9000,
    mismatches: [],
    rowsChecked: 1_766_383,
    sandbox: "postgres 16.4",
    tablesChecked: 5,
  },
  verificationLevel: "restore",
  verificationStatus: "verified",
  verifiedAgainst: "postgres 16.4",
  verifiedAt: null,
  ...overrides,
});

const BASE_ROUTES: Record<string, Route> = {
  "/api-reference/account/me": () => ({ body: { email: "ada@acme.dev", id: "u_1", name: "Ada" } }),
  "/api-reference/encryption/get": () => ({
    body: { canManage: true, maxRecipients: 3, recipients: [], serviceRecipient: "age1service" },
  }),
  "/api-reference/databases/list": () => ({ body: [database()] }),
  "/api-reference/workspace/list": () => ({ body: WORKSPACES }),
};

describe("login", () => {
  it("signs in with the device flow, saves a private config, and logs out", async () => {
    let polls = 0;
    routes["/api/auth/device/code"] = (body) => {
      expect(body.client_id).toBe("backupd-cli");
      return {
        body: {
          device_code: "dev_1",
          expires_in: 600,
          interval: 1,
          user_code: "ABCD2345",
          verification_uri: "https://console.test/device",
          verification_uri_complete: "https://console.test/device?user_code=ABCD2345",
        },
      };
    };
    routes["/api/auth/device/token"] = (body) => {
      expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
      polls += 1;
      return polls < 2
        ? { body: { error: "authorization_pending" }, status: 400 }
        : { body: { access_token: "session_tok", token_type: "Bearer" } };
    };
    routes["/api/auth/api-key/create"] = (_body, req) => {
      expect(req.headers.authorization).toBe("Bearer session_tok");
      return { body: { id: "key_1", key: "bkp_fresh" } };
    };
    routes["/api/auth/sign-out"] = () => ({ body: { success: true } });
    routes["/api/auth/api-key/delete"] = (body, req) => {
      expect(req.headers["x-api-key"]).toBe("bkp_fresh");
      expect(body).toEqual({ keyId: "key_1" });
      return { body: { success: true } };
    };

    const login = await run(["login", "--no-browser"]);
    expect(login.code).toBe(0);
    expect(login.stderr).toContain("ABCD2345");
    expect(login.stderr).toContain("Signed in as ada@acme.dev");
    expect(seen.some((s) => s.path === "/api/auth/sign-out")).toBe(true);

    const path = join(configDir, "config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      apiKey: "bkp_fresh",
      apiKeyId: "key_1",
      workspace: { slug: "acme" },
    });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    const who = await run(["whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({
      user: { email: "ada@acme.dev" },
      workspace: { slug: "acme" },
    });

    const logout = await run(["logout"]);
    expect(logout.code).toBe(0);
    expect(logout.stderr).toContain("revoked");
    expect((await run(["whoami"])).code).toBe(3);
  }, 30_000);

  it("doesn't guess between several workspaces without a terminal", async () => {
    routes["/api-reference/workspace/list"] = () => ({
      body: [
        ...WORKSPACES,
        { id: "org_2", name: "Side", region: "us", role: "member", slug: "side" },
      ],
    });
    const result = await run(["login", "--with-key", "bkp_given"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Pick one: backupd workspace use <acme|side>");
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config.apiKey).toBe("bkp_given");
    expect(config.workspace).toBeUndefined();
    expect((await run(["workspace", "use", "side"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))).toMatchObject({
      workspace: { slug: "side" },
    });
  }, 30_000);

  it("reports a denied sign-in", async () => {
    routes["/api/auth/device/code"] = () => ({
      body: {
        device_code: "d",
        expires_in: 600,
        interval: 1,
        user_code: "X",
        verification_uri: "https://x",
      },
    });
    routes["/api/auth/device/token"] = () => ({ body: { error: "access_denied" }, status: 400 });
    const result = await run(["login", "--no-browser"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("denied");
  }, 30_000);
});

describe("commands", () => {
  it("lists databases as JSON on stdout", async () => {
    const result = await run(["db", "list", "--json"], KEY);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      [database()].map((d) => ({
        ...d,
        lastBackup: expect.any(Object),
        lastBackupAt: expect.any(String),
      })),
    );
    expect(seen.at(-1)?.headers["x-api-key"]).toBe("bkp_test");
  });

  it("runs a backup with --wait and exits 1 when it fails", async () => {
    const states = ["queued", "running", "failed"];
    routes["/api-reference/backups/trigger"] = (body) => {
      expect(body).toEqual({ databaseId: "db_1", organizationId: "org_1" });
      return {
        body: {
          backupId: "bk_9",
          databaseName: "app",
          quota: { allowed: true, remaining: 1, resetAt: null },
        },
      };
    };
    routes["/api-reference/backups/get"] = () => ({
      body: backup({
        errorMessage: "pg_dump: connection refused",
        id: "bk_9",
        phase: "dumping",
        status: states.shift() ?? "failed",
      }),
    });
    const result = await run(["backup", "now", "app", "--wait"], KEY);
    expect(result.stderr).toContain("running: dumping");
    expect(result.stderr).toContain("pg_dump: connection refused");
    expect(result.code).toBe(1);
  }, 30_000);

  it("status exits 1 when a database is stale", async () => {
    routes["/api-reference/databases/list"] = () => ({
      body: [
        database(),
        database({ id: "db_2", lastBackupAt: "2026-01-01T00:00:00.000Z", name: "billing" }),
      ],
    });
    const result = await run(["status"], KEY);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("billing");
    expect(result.stderr).toContain("1 of 2 databases need attention");
  });

  it("won't overwrite the original database without --confirm", async () => {
    routes["/api-reference/backups/get"] = () => ({ body: backup() });
    const result = await run(["restore", "bk_1", "--to-original"], KEY);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--confirm app");
    expect(seen.some((s) => s.path.includes("restores/create"))).toBe(false);
  });

  it("an invalid key exits 3 with a hint", async () => {
    routes["/api-reference/databases/list"] = () => ({
      body: { code: "UNAUTHORIZED", defined: false, message: "Invalid API key", status: 401 },
      status: 401,
    });
    routes["/api-reference/workspace/list"] = routes["/api-reference/databases/list"];
    const result = await run(["db", "list"], KEY);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("backupd login");
  });
});

describe("keys and local decryption", () => {
  it("generates a key, saves the secret privately, and adds only the public key", async () => {
    let added: Record<string, unknown> = {};
    routes["/api-reference/encryption/addRecipient"] = (body) => {
      added = body;
      return { body: { fingerprint: "3f9a1c0be47d2a85", id: "rk_1" } };
    };
    const result = await run(["keys", "generate", "--label", "laptop"], KEY);
    expect(result.code).toBe(0);
    const file = readFileSync(join(workDir, "backupd-laptop.agekey"), "utf8");
    expect(file).toContain("AGE-SECRET-KEY-1");
    expect(String(added.recipient)).toMatch(/^age1/u);
    expect(JSON.stringify(added)).not.toContain("AGE-SECRET-KEY");
    if (process.platform !== "win32") {
      expect(statSync(join(workDir, "backupd-laptop.agekey")).mode & 0o777).toBe(0o600);
    }
  }, 30_000);

  it("downloads the stored file and decrypts it on this machine", async () => {
    routes["/api-reference/encryption/addRecipient"] = () => ({
      body: { fingerprint: "f", id: "rk_1" },
    });
    expect(
      (await run(["keys", "generate", "--label", "laptop", "-o", "my.agekey"], KEY)).code,
    ).toBe(0);
    const keyFile = readFileSync(join(workDir, "my.agekey"), "utf8");
    const recipient = /public key: (age1\S+)/u.exec(keyFile)?.[1] ?? "";

    const dump = new TextEncoder().encode("-- pg_dump output\n".repeat(1000));
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    const stored = await encrypter.encrypt(new Uint8Array(zstdCompressSync(dump)));

    routes["/downloads/backups/bk_1"] = (_body, req) => {
      expect(req.url).toContain("raw=1");
      return { headers: { location: `${baseUrl}/storage/obj` }, status: 302 };
    };
    routes["/storage/obj"] = (_body, req) => {
      expect(req.headers["x-api-key"]).toBeUndefined();
      return {
        headers: {
          "content-disposition": 'attachment; filename="app_20261015T0300.pgdump.zst.age"',
          "content-type": "application/octet-stream",
        },
        raw: stored,
      };
    };
    const result = await run(["backup", "download", "bk_1", "--key", "my.agekey"], KEY);
    expect(result.stderr).toContain("decrypted on this machine");
    expect(result.code).toBe(0);
    expect(readFileSync(join(workDir, "app_20261015T0300.pgdump"))).toEqual(Buffer.from(dump));
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "restores locally by piping the decrypted dump into pg_restore",
    async () => {
      routes["/api-reference/encryption/addRecipient"] = () => ({
        body: { fingerprint: "f", id: "rk_1" },
      });
      expect((await run(["keys", "generate", "--label", "ci", "-o", "ci.agekey"], KEY)).code).toBe(
        0,
      );
      const recipient =
        /public key: (age1\S+)/u.exec(readFileSync(join(workDir, "ci.agekey"), "utf8"))?.[1] ?? "";
      const dump = new TextEncoder().encode("PGDMP fake custom-format archive\n".repeat(200));
      const encrypter = new Encrypter();
      encrypter.addRecipient(recipient);
      const stored = await encrypter.encrypt(new Uint8Array(zstdCompressSync(dump)));

      routes["/api-reference/backups/get"] = () => ({ body: backup() });
      routes["/downloads/backups/bk_1"] = () => ({
        headers: { "content-type": "application/octet-stream" },
        raw: stored,
      });

      // A stand-in pg_restore that records what it was given.
      const bin = mkdtempSync(join(tmpdir(), "backupd-fake-tools-"));
      writeFileSync(
        join(bin, "pg_restore"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${workDir}/args.txt"\ncat > "${workDir}/stdin.bin"\n`,
        { mode: 0o755 },
      );
      const result = await run(
        [
          "restore",
          "bk_1",
          "--local",
          "--key",
          "ci.agekey",
          "--to",
          "postgres://u:p@localhost/staging",
          "--replace",
        ],
        { ...KEY, PATH: `${bin}:${process.env.PATH ?? ""}` },
      );
      expect(result.stderr).toContain("Restored.");
      expect(result.code).toBe(0);
      expect(readFileSync(join(workDir, "stdin.bin"))).toEqual(Buffer.from(dump));
      expect(readFileSync(join(workDir, "args.txt"), "utf8").split("\n")).toEqual(
        expect.arrayContaining([
          "--single-transaction",
          "--clean",
          "--if-exists",
          "-d",
          "postgres://u:p@localhost/staging",
        ]),
      );
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "explains a missing restore tool",
    async () => {
      routes["/api-reference/encryption/addRecipient"] = () => ({
        body: { fingerprint: "f", id: "rk_1" },
      });
      expect((await run(["keys", "generate", "--label", "ci", "-o", "ci.agekey"], KEY)).code).toBe(
        0,
      );
      const recipient =
        /public key: (age1\S+)/u.exec(readFileSync(join(workDir, "ci.agekey"), "utf8"))?.[1] ?? "";
      const encrypter = new Encrypter();
      encrypter.addRecipient(recipient);
      const stored = await encrypter.encrypt(
        new Uint8Array(zstdCompressSync(new TextEncoder().encode("archive"))),
      );
      routes["/api-reference/backups/get"] = () => ({ body: backup({ format: "mongo_archive" }) });
      routes["/downloads/backups/bk_1"] = () => ({ raw: stored });
      const empty = mkdtempSync(join(tmpdir(), "backupd-no-tools-"));
      const result = await run(
        ["restore", "bk_1", "--local", "--key", "ci.agekey", "--to", "mongodb://localhost/x"],
        {
          ...KEY,
          PATH: empty,
        },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("mongorestore isn't installed");
    },
    30_000,
  );

  it("fails clearly with the wrong key", async () => {
    writeFileSync(
      join(workDir, "wrong.agekey"),
      "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQSRLS6R\n",
    );
    routes["/downloads/backups/bk_1"] = () => ({ raw: new Uint8Array([1, 2, 3]) });
    const result = await run(["backup", "download", "bk_1", "--key", "wrong.agekey"], KEY);
    expect(result.code).toBe(1);
  }, 30_000);
});
