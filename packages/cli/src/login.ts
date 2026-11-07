/**
 * `backupd login`: the OAuth 2.0 device flow (RFC 8628).
 *
 * 1. Ask the API for a device code and a short user code.
 * 2. Open the approval page in the browser; the user signs in and approves.
 * 3. Poll until approved, which yields a short-lived session.
 * 4. Use it once to create an API key named after this machine, then end
 *    the session. The key is what the CLI keeps; revoke it any time in
 *    Settings → API & MCP, or with `backupd logout`.
 */
import { spawn } from "node:child_process";
import { hostname } from "node:os";

import { ConfigError, NetworkError } from "@backupd/sdk/effect";
import { Duration, Effect } from "effect";

export const CLIENT_ID = "backupd-cli";

interface DeviceCode {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval?: number;
}

const post = (apiUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  Effect.tryPromise({
    catch: (cause) =>
      new NetworkError({
        cause,
        message: `Couldn't reach ${apiUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
        operation: path,
      }),
    try: async () => {
      const response = await fetch(`${apiUrl}/api/auth${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { message: text };
      }
      return { body: parsed, status: response.status };
    },
  });

const fail = (message: string) => Effect.fail(new ConfigError({ message }));

/** Opens a URL in the default browser. Never fails: the URL is printed too. */
export const openBrowser = (url: string) =>
  Effect.sync(() => {
    const [command, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url.replaceAll("&", "^&")]]
          : ["xdg-open", [url]];
    try {
      const child = spawn(command, args as string[], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    } catch {
      // No browser here (SSH, container). The printed link still works.
    }
  });

export const requestDeviceCode = (apiUrl: string) =>
  Effect.gen(function* () {
    const { body, status } = yield* post(apiUrl, "/device/code", {
      client_id: CLIENT_ID,
      scope: "openid profile email",
    });
    if (status !== 200 || typeof body.device_code !== "string") {
      return yield* fail(
        `Couldn't start sign-in (${status}): ${String(body.error_description ?? body.message ?? body.error ?? "unknown error")}`,
      );
    }
    return body as unknown as DeviceCode;
  });

/** Polls until the user approves; returns the session token. */
export const waitForApproval = (apiUrl: string, code: DeviceCode) =>
  Effect.gen(function* () {
    let interval = Math.max(code.interval ?? 5, 1);
    const deadline = Date.now() + code.expires_in * 1000;
    while (Date.now() < deadline) {
      yield* Effect.sleep(Duration.seconds(interval));
      const { body, status } = yield* post(apiUrl, "/device/token", {
        client_id: CLIENT_ID,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (status === 200 && typeof body.access_token === "string") {
        return body.access_token;
      }
      switch (body.error) {
        case "authorization_pending": {
          continue;
        }
        case "slow_down": {
          interval += 5;
          continue;
        }
        case "access_denied": {
          return yield* fail("Sign-in was denied in the browser.");
        }
        case "expired_token": {
          return yield* fail("The sign-in code expired. Run `backupd login` again.");
        }
        default: {
          return yield* fail(
            `Sign-in failed (${status}): ${String(body.error_description ?? body.message ?? body.error ?? "unknown error")}`,
          );
        }
      }
    }
    return yield* fail("The sign-in code expired. Run `backupd login` again.");
  });

/** Trades the session for an API key named after this machine, then ends the session. */
export const createMachineKey = (apiUrl: string, sessionToken: string) =>
  Effect.gen(function* () {
    const bearer = { authorization: `Bearer ${sessionToken}` };
    const { body, status } = yield* post(
      apiUrl,
      "/api-key/create",
      { name: `CLI on ${hostname()}` },
      bearer,
    );
    if (status !== 200 || typeof body.key !== "string") {
      return yield* fail(
        `Signed in, but couldn't create an API key (${status}): ${String(body.message ?? "unknown error")}`,
      );
    }
    yield* post(apiUrl, "/sign-out", {}, bearer).pipe(Effect.ignore);
    return { id: typeof body.id === "string" ? body.id : undefined, key: body.key };
  });

/** Revokes an API key using the key itself. Best effort. */
export const revokeKey = (apiUrl: string, apiKey: string, keyId: string) =>
  post(apiUrl, "/api-key/delete", { keyId }, { "x-api-key": apiKey }).pipe(
    Effect.map(({ status }) => status === 200),
    Effect.orElseSucceed(() => false),
  );
