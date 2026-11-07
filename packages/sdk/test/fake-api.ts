/**
 * A tiny stand-in for the backupd API, for tests: a `fetch` that routes
 * requests to handlers and records what it was sent.
 */
export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Handler = (body: Record<string, unknown>, request: Recorded) => Response | Promise<Response>;

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });

export const apiError = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) => json({ code, defined: false, message, status }, status, headers);

export const fakeApi = (routes: Record<string, Handler>) => {
  const calls: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const text = typeof init?.body === "string" ? init.body : "";
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const recorded: Recorded = { body, headers, method: init?.method ?? "GET", url };
    calls.push(recorded);
    const path = new URL(url).pathname.replace(/^\/api-reference\//u, "");
    const handler = routes[path] ?? routes[url];
    if (!handler) {
      return apiError(404, "NOT_FOUND", `No fake route for ${path}`);
    }
    return handler(body, recorded);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

export const WORKSPACES = [
  { id: "org_1", name: "Acme", region: "eu", role: "owner", slug: "acme" },
  { id: "org_2", name: "Side project", region: "us", role: "member", slug: "side" },
];

export const backup = (overrides: Record<string, unknown> = {}) => ({
  checksum: "sha256:abc",
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
  encryption: { algorithm: "age-v1", recipients: ["3f9a1c0be47d2a85"] },
  errorMessage: null,
  fileName: "app_20261015T0300",
  finishedAt: "2026-10-15T03:00:41.000Z",
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
  verificationDetails: null,
  verificationLevel: "restore",
  verificationStatus: "verified",
  verifiedAgainst: "postgres 16.4",
  verifiedAt: "2026-10-15T03:01:20.000Z",
  // Fields the SDK doesn't model must be ignored.
  somethingNew: { nested: true },
  ...overrides,
});
