import { describe, expect, it } from "vitest";

import { ApiError, Backupd, ConfigError, OperationFailed } from "../src/index.js";
import { WORKSPACES, apiError, backup, fakeApi, json } from "./fake-api.js";

const BASE = "https://api.test";

describe("requests", () => {
  it("POSTs JSON to /api-reference with the key and the resolved workspace", async () => {
    const api = fakeApi({
      "databases/list": () => json([]),
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({
      apiKey: "bkp_test",
      baseUrl: BASE,
      fetch: api.fetch,
      workspace: "acme",
    });

    await client.databases.list();

    const call = api.calls.at(-1);
    expect(call?.url).toBe(`${BASE}/api-reference/databases/list`);
    expect(call?.method).toBe("POST");
    expect(call?.headers["x-api-key"]).toBe("bkp_test");
    expect(call?.headers["user-agent"]).toMatch(/^backupd-sdk-js\//u);
    expect(call?.body).toEqual({ organizationId: "org_1" });
  });

  it("resolves the workspace once per client", async () => {
    const api = fakeApi({
      "databases/list": () => json([]),
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({
      apiKey: "k",
      baseUrl: BASE,
      fetch: api.fetch,
      workspace: "org_2",
    });
    await client.databases.list();
    await client.databases.list();
    expect(api.calls.filter((c) => c.url.endsWith("workspace/list"))).toHaveLength(1);
    expect(api.calls.at(-1)?.body).toEqual({ organizationId: "org_2" });
  });

  it("uses the only workspace when none is given, and asks when there are several", async () => {
    const one = fakeApi({
      "databases/list": () => json([]),
      "workspace/list": () => json([WORKSPACES[0]]),
    });
    await new Backupd({ apiKey: "k", baseUrl: BASE, fetch: one.fetch }).databases.list();
    expect(one.calls.at(-1)?.body).toEqual({ organizationId: "org_1" });

    const two = fakeApi({ "workspace/list": () => json(WORKSPACES) });
    await expect(
      new Backupd({ apiKey: "k", baseUrl: BASE, fetch: two.fetch }).databases.list(),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("fails without an API key, before any request", async () => {
    const api = fakeApi({});
    const previous = process.env.BACKUPD_API_KEY;
    delete process.env.BACKUPD_API_KEY;
    try {
      const error = await new Backupd({ baseUrl: BASE, fetch: api.fetch }).account
        .me()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect(api.calls).toHaveLength(0);
    } finally {
      if (previous !== undefined) {
        process.env.BACKUPD_API_KEY = previous;
      }
    }
  });
});

describe("errors", () => {
  it("turns the API's error body into an ApiError", async () => {
    const api = fakeApi({
      "backups/get": () => apiError(404, "NOT_FOUND", "Backup not found"),
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({ apiKey: "k", baseUrl: BASE, fetch: api.fetch, workspace: "acme" });
    const error = await client.backups.get("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "NOT_FOUND",
      message: "Backup not found",
      operation: "backups.get",
      status: 404,
    });
  });

  it("keeps plain-text errors readable", async () => {
    const api = fakeApi({
      "account/me": () => new Response("Internal Server Error", { status: 500 }),
    });
    const error = await new Backupd({ apiKey: "k", baseUrl: BASE, fetch: api.fetch }).account
      .me()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "HTTP_500",
      message: "Internal Server Error",
      status: 500,
    });
  });

  it("retries a rate-limited call after Retry-After", async () => {
    let attempts = 0;
    const api = fakeApi({
      "account/me": () => {
        attempts += 1;
        return attempts === 1
          ? apiError(429, "TOO_MANY_REQUESTS", "Rate limit exceeded.", { "retry-after": "0.01" })
          : json({ email: "a@b.c", id: "u1", name: "Ada" });
      },
    });
    const waits: number[] = [];
    const me = await new Backupd({
      apiKey: "k",
      baseUrl: BASE,
      fetch: api.fetch,
      onRateLimited: (seconds) => waits.push(seconds),
    }).account.me();
    expect(me.name).toBe("Ada");
    expect(attempts).toBe(2);
    expect(waits).toEqual([0.01]);
  });

  it("doesn't retry a manual-backup quota error (429 without Retry-After)", async () => {
    let attempts = 0;
    const api = fakeApi({
      "backups/trigger": () => {
        attempts += 1;
        return apiError(
          429,
          "TOO_MANY_REQUESTS",
          "Starter allows 2 manual backups per database per day",
        );
      },
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({ apiKey: "k", baseUrl: BASE, fetch: api.fetch, workspace: "acme" });
    await expect(client.backups.trigger("db_1")).rejects.toMatchObject({ status: 429 });
    expect(attempts).toBe(1);
  });
});

describe("waiting", () => {
  it("polls a backup until it finishes and reports progress", async () => {
    const states = ["queued", "running", "succeeded"];
    const api = fakeApi({
      "backups/get": () => json(backup({ status: states.shift() ?? "succeeded" })),
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({ apiKey: "k", baseUrl: BASE, fetch: api.fetch, workspace: "acme" });
    const seen: string[] = [];
    const done = await client.backups.wait("bk_1", {
      interval: 1,
      onProgress: (b) => seen.push(b.status),
    });
    expect(done.status).toBe("succeeded");
    expect(seen).toEqual(["queued", "running", "succeeded"]);
  });

  it("fails with OperationFailed when the backup fails", async () => {
    const api = fakeApi({
      "backups/get": () =>
        json(backup({ errorMessage: "pg_dump: permission denied for table x", status: "failed" })),
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({ apiKey: "k", baseUrl: BASE, fetch: api.fetch, workspace: "acme" });
    const error = await client.backups.wait("bk_1", { interval: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationFailed);
    expect(error).toMatchObject({
      message: "pg_dump: permission denied for table x",
      status: "failed",
    });
  });

  it("waits for a restore through its backup", async () => {
    const run = (status: string) => ({
      createdAt: "2026-10-15T04:00:00.000Z",
      error: null,
      finishedAt: null,
      id: "rs_1",
      rowsRestored: 10,
      status,
      tablesRestored: 1,
      target: "custom",
      targetLabel: "staging.acme.dev",
    });
    const states = ["running", "succeeded"];
    const api = fakeApi({
      "backups/get": () => json(backup({ restores: [run(states.shift() ?? "succeeded")] })),
      "restores/create": (body) => {
        expect(body).toMatchObject({
          backupId: "bk_1",
          target: { connectionString: "postgres://x", kind: "custom" },
        });
        return json({ restoreId: "rs_1" });
      },
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({ apiKey: "k", baseUrl: BASE, fetch: api.fetch, workspace: "acme" });
    const handle = await client.restores.create({
      backupId: "bk_1",
      target: { connectionString: "postgres://x", kind: "custom" },
    });
    expect(handle).toEqual({ backupId: "bk_1", restoreId: "rs_1" });
    const finished = await client.restores.wait(handle, { interval: 1 });
    expect(finished.status).toBe("succeeded");
  });

  it("sends confirmName for a restore into the original database", async () => {
    const api = fakeApi({
      "restores/create": (body) => {
        expect(body).toEqual({
          backupId: "bk_1",
          confirmName: "app",
          organizationId: "org_1",
          replaceExisting: true,
          target: { kind: "original" },
        });
        return json({ restoreId: "rs_2" });
      },
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({ apiKey: "k", baseUrl: BASE, fetch: api.fetch, workspace: "acme" });
    await client.restores.create({
      backupId: "bk_1",
      replaceExisting: true,
      target: { confirmName: "app", kind: "original" },
    });
  });
});

describe("downloads", () => {
  it("follows the raw redirect without sending the API key to storage", async () => {
    const storage = "https://storage.test/obj?sig=1";
    const api = fakeApi({
      [`${BASE}/downloads/backups/bk_1?organizationId=org_1&raw=1`]: () =>
        new Response(null, { headers: { location: storage }, status: 302 }),
      [storage]: () =>
        new Response("ciphertext", {
          headers: {
            "content-disposition": 'attachment; filename="app_20261015T0300.pgdump.zst.age"',
            "content-length": "10",
          },
        }),
      "workspace/list": () => json(WORKSPACES),
    });
    const client = new Backupd({
      apiKey: "bkp_secret",
      baseUrl: BASE,
      fetch: api.fetch,
      workspace: "acme",
    });
    const file = await client.backups.download("bk_1", { raw: true });

    expect(file.fileName).toBe("app_20261015T0300.pgdump.zst.age");
    expect(file.size).toBe(10);
    expect(await new Response(file.stream).text()).toBe("ciphertext");
    const toStorage = api.calls.find((c) => c.url === storage);
    expect(toStorage?.headers["x-api-key"]).toBeUndefined();
  });
});
