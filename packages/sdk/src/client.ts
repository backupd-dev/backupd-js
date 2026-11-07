import { Clock, Duration, Effect, Schema } from "effect";

import {
  ApiError,
  ConfigError,
  NetworkError,
  OperationFailed,
  ResponseError,
  WaitTimeout,
} from "./errors.js";
import * as S from "./schemas.js";

export const DEFAULT_BASE_URL = "https://api.backupd.dev";
export const SDK_VERSION = "0.1.0";

export interface ClientOptions {
  /** A `bkp_…` API key. Defaults to the `BACKUPD_API_KEY` environment variable. */
  readonly apiKey?: string | undefined;
  /** Defaults to `BACKUPD_API_URL`, then https://api.backupd.dev. */
  readonly baseUrl?: string | undefined;
  /**
   * Workspace ID or slug the client works in. Defaults to `BACKUPD_WORKSPACE`;
   * if that's unset too and your key can see exactly one workspace, that one.
   */
  readonly workspace?: string | undefined;
  /** Replace `fetch`, for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Prepended to the User-Agent header, e.g. `my-tool/1.2`. */
  readonly userAgent?: string | undefined;
}

export type ApiFailure = ApiError | ConfigError | NetworkError | ResponseError;

export interface ListBackupsOptions {
  readonly databaseId?: string | undefined;
  /** Recently deleted backups instead of live ones. */
  readonly deleted?: boolean | undefined;
  /** 1–100, default 50. */
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export type Connection =
  | { readonly engine: "postgres" | "mysql" | "mongodb"; readonly connectionString: string }
  | {
      readonly engine: "convex";
      readonly deploymentUrl: string;
      readonly deployKey: string;
      readonly selfHosted?: boolean | undefined;
    };

export interface CreateDatabaseInput {
  readonly name: string;
  readonly connection: Connection;
  readonly schedule: S.ScheduleId;
  /** UTC hour (0–23) the schedule starts from. */
  readonly scheduleHour?: number | undefined;
  readonly retentionDays: number;
}

export type RestoreTarget =
  | {
      readonly kind: "original";
      /** The database's name, typed out to confirm the overwrite. */
      readonly confirmName: string;
    }
  | { readonly kind: "custom"; readonly connectionString: string };

export interface CreateRestoreInput {
  readonly backupId: string;
  readonly target: RestoreTarget;
  /** Drop and replace tables that already exist in the target. */
  readonly replaceExisting?: boolean | undefined;
}

export interface RestoreHandle {
  readonly restoreId: string;
  readonly backupId: string;
}

export interface WaitOptions<A> {
  /** Give up after this long. Default 6 hours (the longest a backup may run). */
  readonly timeout?: Duration.Input | undefined;
  /** Time between checks. Default 3 seconds. */
  readonly interval?: Duration.Input | undefined;
  /** Called after every check, e.g. to show progress. */
  readonly onProgress?: ((value: A) => void) | undefined;
}

export interface DownloadOptions {
  /**
   * `false` (default): the plain dump, decrypted by backupd.
   * `true`: the file exactly as stored, age-encrypted and zstd-compressed,
   * to open yourself with your own key.
   */
  readonly raw?: boolean | undefined;
}

export interface Download {
  readonly fileName: string;
  readonly stream: ReadableStream<Uint8Array>;
  /** Bytes, when the server sends a length. */
  readonly size: number | undefined;
}

const TERMINAL = new Set<S.RunStatus>(["succeeded", "failed", "cancelled"]);

const fileNameFrom = (header: string | null, fallback: string): string => {
  const match = header?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/iu);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
};

const readEnv = (name: string): string | undefined =>
  typeof process === "undefined" ? undefined : process.env[name] || undefined;

/**
 * Builds a client. Every method is an Effect; `@backupd/sdk` wraps the same
 * methods in Promises.
 */
export const makeClient = (options: ClientOptions = {}) => {
  const apiKey = options.apiKey ?? readEnv("BACKUPD_API_KEY");
  const baseUrl = (options.baseUrl ?? readEnv("BACKUPD_API_URL") ?? DEFAULT_BASE_URL).replace(
    /\/+$/u,
    "",
  );
  const doFetch = options.fetch ?? globalThis.fetch;
  const userAgent = [options.userAgent, `backupd-sdk-js/${SDK_VERSION}`].filter(Boolean).join(" ");
  const workspaceRef = options.workspace ?? readEnv("BACKUPD_WORKSPACE");

  const headers = Effect.suspend(() =>
    apiKey
      ? Effect.succeed({
          "content-type": "application/json",
          "user-agent": userAgent,
          "x-api-key": apiKey,
        })
      : Effect.fail(
          new ConfigError({
            message: "No API key. Pass apiKey, set BACKUPD_API_KEY, or run `backupd login`.",
          }),
        ),
  );

  const send = (operation: string, url: string, init: RequestInit) =>
    Effect.tryPromise({
      catch: (cause) =>
        new NetworkError({
          cause,
          message: `Couldn't reach ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
          operation,
        }),
      try: (signal) => doFetch(url, { ...init, signal }),
    });

  /** Turns a non-2xx answer into an ApiError. */
  const failure = (operation: string, response: Response) =>
    Effect.gen(function* () {
      const text = yield* Effect.promise(() => response.text().catch(() => ""));
      let code = `HTTP_${response.status}`;
      let message = text.trim() || response.statusText || "Request failed";
      try {
        const body = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof body.code === "string") {
          code = body.code;
        }
        if (typeof body.message === "string") {
          message = body.message;
        }
      } catch {
        // Not JSON; keep the text.
      }
      if (response.status === 401) {
        code = "UNAUTHORIZED";
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      return yield* Effect.fail(
        new ApiError({
          code,
          message,
          operation,
          status: response.status,
          ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
        }),
      );
    });

  /** Retries rate-limited calls (429 with Retry-After), up to three times. */
  const withRateLimitRetry = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const attempt = (left: number): Effect.Effect<A, E, R> =>
      Effect.catchIf(
        effect,
        (error): error is E =>
          left > 0 &&
          error instanceof ApiError &&
          error.status === 429 &&
          error.retryAfter !== undefined &&
          error.retryAfter <= 60,
        (error) =>
          Effect.flatMap(Effect.sleep(Duration.seconds((error as ApiError).retryAfter ?? 1)), () =>
            attempt(left - 1),
          ),
      );
    return attempt(3);
  };

  /** POST /api-reference/<operation> and decode the answer. */
  const call = <Sc extends Schema.Decoder<unknown>>(
    operation: string,
    schema: Sc,
    body: Record<string, unknown>,
  ): Effect.Effect<Sc["Type"], ApiFailure> =>
    withRateLimitRetry(
      Effect.gen(function* () {
        const response = yield* send(
          operation,
          `${baseUrl}/api-reference/${operation.replace(".", "/")}`,
          {
            body: JSON.stringify(body),
            headers: yield* headers,
            method: "POST",
          },
        );
        if (!response.ok) {
          return yield* failure(operation, response);
        }
        const json = yield* Effect.tryPromise({
          catch: () =>
            new ResponseError({ message: "The API sent a body that isn't JSON.", operation }),
          try: () => response.json() as Promise<unknown>,
        });
        return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(
            (error) =>
              new ResponseError({
                message: `Unexpected response from ${operation}: ${error.message}`,
                operation,
              }),
          ),
        );
      }),
    );

  /* ---------------------------------------------------------------- */
  /* Account and workspaces                                            */
  /* ---------------------------------------------------------------- */

  const me = call("account.me", S.Me, {});
  const listWorkspaces = call("workspace.list", Schema.Array(S.Workspace), {});

  /** Finds a workspace by ID or slug among the ones the key can see. */
  const findWorkspace = (ref: string | undefined) =>
    Effect.gen(function* () {
      const workspaces = yield* listWorkspaces;
      if (ref) {
        const found = workspaces.find((w) => w.id === ref || w.slug === ref);
        if (!found) {
          return yield* Effect.fail(
            new ConfigError({
              message: `No workspace "${ref}". Yours: ${workspaces.map((w) => w.slug).join(", ") || "none"}.`,
            }),
          );
        }
        return found;
      }
      const [only, ...rest] = workspaces;
      if (only && rest.length === 0) {
        return only;
      }
      return yield* Effect.fail(
        new ConfigError({
          message:
            workspaces.length === 0
              ? "This account isn't in any workspace yet."
              : `Pick a workspace (${workspaces.map((w) => w.slug).join(", ")}): pass workspace, set BACKUPD_WORKSPACE, or run \`backupd workspace use\`.`,
        }),
      );
    });

  // Resolve the workspace once per client.
  let resolved: string | undefined;
  const organizationId = Effect.suspend(() => {
    if (resolved) {
      return Effect.succeed(resolved);
    }
    return findWorkspace(workspaceRef).pipe(
      Effect.map((workspace) => workspace.id),
      Effect.tap((id) =>
        Effect.sync(() => {
          resolved = id;
        }),
      ),
    );
  });

  const inWorkspace = <Sc extends Schema.Decoder<unknown>>(
    operation: string,
    schema: Sc,
    body: Record<string, unknown> = {},
  ) =>
    Effect.flatMap(organizationId, (id) =>
      call(operation, schema, { ...body, organizationId: id }),
    );

  /* ---------------------------------------------------------------- */
  /* Waiting                                                           */
  /* ---------------------------------------------------------------- */

  const poll = <A, E>(
    kind: "backup" | "restore",
    id: string,
    check: Effect.Effect<A, E>,
    done: (value: A) => boolean,
    options: WaitOptions<A>,
  ) =>
    Effect.gen(function* () {
      const timeout = Duration.fromInputUnsafe(options.timeout ?? "6 hours");
      const interval = Duration.fromInputUnsafe(options.interval ?? "3 seconds");
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout);
      while (true) {
        const value = yield* check;
        options.onProgress?.(value);
        if (done(value)) {
          return value;
        }
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* Effect.fail(
            new WaitTimeout({
              id,
              kind,
              message: `Stopped waiting for ${kind} ${id} after ${Duration.format(timeout)}. It may still finish.`,
            }),
          );
        }
        yield* Effect.sleep(interval);
      }
    });

  const getBackup = (backupId: string) => inWorkspace("backups.get", S.Backup, { backupId });

  const waitForBackup = (backupId: string, options: WaitOptions<S.Backup> = {}) =>
    poll("backup", backupId, getBackup(backupId), (b) => TERMINAL.has(b.status), options).pipe(
      Effect.flatMap((backup) =>
        backup.status === "succeeded"
          ? Effect.succeed(backup)
          : Effect.fail(
              new OperationFailed({
                id: backup.id,
                kind: "backup",
                message:
                  backup.errorMessage ??
                  `The backup ${backup.status === "cancelled" ? "was cancelled" : "failed"}.`,
                status: backup.status,
              }),
            ),
      ),
    );

  const restoreOf = ({ backupId, restoreId }: RestoreHandle) =>
    Effect.flatMap(getBackup(backupId), (backup) => {
      const run = backup.restores.find((r) => r.id === restoreId);
      return run
        ? Effect.succeed(run)
        : Effect.fail(
            new ApiError({
              code: "NOT_FOUND",
              message: `Restore ${restoreId} not found on backup ${backupId}.`,
              operation: "backups.get",
              status: 404,
            }),
          );
    });

  const waitForRestore = (handle: RestoreHandle, options: WaitOptions<S.RestoreRun> = {}) =>
    poll(
      "restore",
      handle.restoreId,
      restoreOf(handle),
      (r) => TERMINAL.has(r.status),
      options,
    ).pipe(
      Effect.flatMap((run) =>
        run.status === "succeeded"
          ? Effect.succeed(run)
          : Effect.fail(
              new OperationFailed({
                id: run.id,
                kind: "restore",
                message:
                  run.error ??
                  `The restore ${run.status === "cancelled" ? "was cancelled" : "failed"}.`,
                status: run.status,
              }),
            ),
      ),
    );

  /* ---------------------------------------------------------------- */
  /* Downloads                                                         */
  /* ---------------------------------------------------------------- */

  const download = (backupId: string, options: DownloadOptions = {}) =>
    Effect.gen(function* () {
      const id = yield* organizationId;
      const operation = "backups.download";
      const query = new URLSearchParams({
        organizationId: id,
        ...(options.raw ? { raw: "1" } : {}),
      });
      const { "x-api-key": key, "user-agent": agent } = yield* headers;
      // Raw downloads redirect to a short-lived storage URL. Follow it by
      // hand so the API key is never sent to the storage host.
      let response = yield* send(
        operation,
        `${baseUrl}/downloads/backups/${encodeURIComponent(backupId)}?${query}`,
        {
          headers: { "user-agent": agent, "x-api-key": key },
          method: "GET",
          redirect: "manual",
        },
      );
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        response = yield* send(operation, new URL(location, baseUrl).toString(), {
          headers: { "user-agent": agent },
          method: "GET",
        });
      }
      if (!response.ok || !response.body) {
        return yield* failure(operation, response);
      }
      const length = Number(response.headers.get("content-length"));
      return {
        fileName: fileNameFrom(
          response.headers.get("content-disposition"),
          `${backupId}${options.raw ? ".zst.age" : ""}`,
        ),
        size: Number.isFinite(length) && length > 0 ? length : undefined,
        stream: response.body,
      } satisfies Download;
    });

  /* ---------------------------------------------------------------- */

  return {
    account: { me },
    backups: {
      cancel: (backupId: string) => inWorkspace("backups.cancel", S.CancelledBackup, { backupId }),
      download,
      get: getBackup,
      /** The newest backup of a database that finished and has a file. */
      latest: (databaseId: string) =>
        Effect.flatMap(
          inWorkspace("backups.list", S.BackupPage, { databaseId, limit: 25 }),
          (page) => {
            const found = page.items.find((b) => b.status === "succeeded" && b.hasFile);
            return found
              ? Effect.succeed(found)
              : Effect.fail(
                  new ApiError({
                    code: "NOT_FOUND",
                    message: "This database has no finished backup yet.",
                    operation: "backups.list",
                    status: 404,
                  }),
                );
          },
        ),
      list: (options: ListBackupsOptions = {}) =>
        inWorkspace("backups.list", S.BackupPage, { ...options }),
      quota: (databaseId: string) =>
        inWorkspace("backups.manualQuota", S.ManualQuota, { databaseId }),
      recover: (backupIds: ReadonlyArray<string>) =>
        inWorkspace("backups.recover", Schema.Unknown, { backupIds }),
      /** Starts a backup now. Counts against the plan's daily manual backups. */
      trigger: (databaseId: string) =>
        inWorkspace("backups.trigger", S.TriggeredBackup, { databaseId }),
      wait: waitForBackup,
    },
    baseUrl,
    databases: {
      create: (input: CreateDatabaseInput) =>
        inWorkspace("databases.create", S.CreatedDatabase, { ...input }),
      get: (databaseId: string) => inWorkspace("databases.get", S.DatabaseDetail, { databaseId }),
      list: () => inWorkspace("databases.list", Schema.Array(S.Database)),
      pause: (databaseId: string) =>
        inWorkspace("databases.setStatus", S.DatabaseChange, { databaseId, status: "paused" }),
      remove: (databaseId: string) =>
        inWorkspace("databases.remove", S.DatabaseChange, { databaseId }),
      resume: (databaseId: string) =>
        inWorkspace("databases.setStatus", S.DatabaseChange, { databaseId, status: "active" }),
      testConnection: (connection: Connection) =>
        inWorkspace("databases.testConnection", S.ConnectionTest, { connection }),
    },
    keys: {
      add: (input: { readonly recipient: string; readonly label: string }) =>
        inWorkspace("encryption.addRecipient", S.AddedKey, { ...input }),
      list: () => inWorkspace("encryption.get", S.Encryption),
      revoke: (recipientId: string) =>
        inWorkspace("encryption.revokeRecipient", S.RevokedKey, { recipientId }),
    },
    restores: {
      cancel: (restoreId: string) => inWorkspace("restores.cancel", S.Ok, { restoreId }),
      /** Starts a restore. Owners and admins only. */
      create: (input: CreateRestoreInput) =>
        inWorkspace("restores.create", S.CreatedRestore, {
          backupId: input.backupId,
          ...(input.replaceExisting === undefined
            ? {}
            : { replaceExisting: input.replaceExisting }),
          ...(input.target.kind === "original"
            ? { confirmName: input.target.confirmName, target: { kind: "original" } }
            : { target: { connectionString: input.target.connectionString, kind: "custom" } }),
        }).pipe(
          Effect.map(({ restoreId }): RestoreHandle => ({ backupId: input.backupId, restoreId })),
        ),
      get: restoreOf,
      list: (databaseId: string) =>
        inWorkspace("restores.list", Schema.Array(S.RestoreSummary), { databaseId }),
      wait: waitForRestore,
    },
    workspaces: {
      /** The workspace this client works in. */
      current: Effect.flatMap(organizationId, (id) =>
        Effect.flatMap(listWorkspaces, (all) => {
          const found = all.find((w) => w.id === id);
          return found
            ? Effect.succeed(found)
            : Effect.fail(
                new ConfigError({ message: `Workspace ${id} isn't visible to this key.` }),
              );
        }),
      ),
      find: findWorkspace,
      list: listWorkspaces,
    },
  };
};

export type BackupdClient = ReturnType<typeof makeClient>;
