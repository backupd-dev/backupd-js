import { makeClient } from "@backupd/sdk/effect";
import type { Workspace } from "@backupd/sdk/effect";
import { Effect, Option } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";

import { configPath, readConfig, removeConfig, updateConfig } from "../config.js";
import { Json, WorkspaceFlag, apiUrl, client } from "../context.js";
import {
  createMachineKey,
  openBrowser,
  requestDeviceCode,
  revokeKey,
  waitForApproval,
} from "../login.js";
import * as out from "../output.js";
import { VERSION } from "../version.js";

const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stderr.isTTY);

/** Picks the workspace to save: the only one, the one asked for, or a prompt. */
const chooseWorkspace = (workspaces: ReadonlyArray<Workspace>, wanted: string | undefined) =>
  Effect.gen(function* () {
    if (wanted) {
      return workspaces.find((w) => w.slug === wanted || w.id === wanted);
    }
    if (workspaces.length <= 1) {
      return workspaces[0];
    }
    if (!interactive()) {
      // Don't guess between several; `workspace use` or --workspace decides.
      return undefined;
    }
    return yield* Prompt.run(
      Prompt.Select({
        choices: workspaces.map((w) => ({
          description: w.role,
          title: `${w.name} (${w.slug})`,
          value: w,
        })),
        message: "Which workspace should the CLI use?",
      }),
    );
  });

export const login = Command.make(
  "login",
  {
    apiKey: Flag.String("with-key").pipe(
      Flag.withDescription("Save this API key instead of signing in through the browser."),
      Flag.optional,
    ),
    browser: Flag.Boolean("browser").pipe(
      Flag.withDescription("Open the sign-in page automatically (--no-browser to just print it)."),
      Flag.withDefault(true),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const url = yield* apiUrl;
      let key = Option.getOrUndefined(flags.apiKey);
      let keyId: string | undefined;

      if (!key) {
        const code = yield* requestDeviceCode(url);
        const link = code.verification_uri_complete ?? code.verification_uri;
        yield* out.note(`To sign in, open ${out.cyan(link)}`);
        yield* out.note(`and check the code matches: ${out.bold(code.user_code)}`);
        if (flags.browser) {
          yield* openBrowser(link);
        }
        yield* out.note(out.dim("Waiting for you to approve in the browser…"));
        const session = yield* waitForApproval(url, code);
        const created = yield* createMachineKey(url, session);
        key = created.key;
        keyId = created.id;
      }

      const api = makeClient({ apiKey: key, baseUrl: url, userAgent: `backupd-cli/${VERSION}` });
      const me = yield* api.account.me;
      const workspaces = yield* api.workspaces.list;
      const workspace = yield* chooseWorkspace(
        workspaces,
        Option.getOrUndefined(yield* WorkspaceFlag),
      );

      yield* updateConfig((config) => ({
        ...config,
        apiKey: key,
        ...(keyId ? { apiKeyId: keyId } : {}),
        ...(url === "https://api.backupd.dev" ? {} : { apiUrl: url }),
        email: me.email,
        ...(workspace
          ? { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug } }
          : {}),
      }));

      yield* out.success(`Signed in as ${out.bold(me.email)}`);
      if (workspace) {
        yield* out.success(`Workspace: ${workspace.name} (${workspace.slug})`);
      } else if (workspaces.length > 1) {
        yield* out.warn(
          `You're in ${workspaces.length} workspaces. Pick one: backupd workspace use <${workspaces.map((w) => w.slug).join("|")}>`,
        );
      } else {
        yield* out.warn(
          "You're not in a workspace yet. Create one at https://console.backupd.dev.",
        );
      }
      yield* out.note(out.dim(`Saved to ${configPath()}`));
    }),
).pipe(
  Command.withDescription("Sign in through the browser and save an API key for this machine."),
);

export const logout = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const config = yield* readConfig;
    if (!config.apiKey) {
      yield* out.note("You're not logged in.");
      return;
    }
    const revoked = config.apiKeyId
      ? yield* revokeKey(yield* apiUrl, config.apiKey, config.apiKeyId)
      : false;
    yield* removeConfig;
    yield* out.success(revoked ? "Logged out and revoked this machine's API key." : "Logged out.");
    if (!revoked) {
      yield* out.note(
        out.dim("If you saved a key with --with-key, revoke it in Settings → API & MCP."),
      );
    }
  }),
).pipe(Command.withDescription("Forget the saved key and revoke it."));

export const whoami = Command.make("whoami", {}, () =>
  Effect.gen(function* () {
    const api = yield* client;
    const me = yield* api.account.me;
    const workspace = yield* api.workspaces.current.pipe(Effect.option);
    const asJson = yield* Json;
    const value = { user: me, workspace: Option.getOrNull(workspace) };
    yield* out.either(
      asJson,
      value,
      out.details([
        ["User", `${me.name} <${me.email}>`],
        [
          "Workspace",
          Option.match(workspace, {
            onNone: () => out.dim("none selected (backupd workspace use <slug>)"),
            onSome: (w) => `${w.name} (${w.slug}), ${w.role}`,
          }),
        ],
        ["API", api.baseUrl],
      ]),
    );
  }),
).pipe(Command.withDescription("Show who you're signed in as, and the current workspace."));

const workspaceList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const api = yield* client;
    const workspaces = yield* api.workspaces.list;
    const current = (yield* readConfig).workspace?.id;
    yield* out.either(
      yield* Json,
      workspaces,
      out.table(workspaces, [
        { header: "", value: (w) => (w.id === current ? out.green("●") : " ") },
        { header: "Slug", value: (w) => w.slug },
        { header: "Name", value: (w) => w.name },
        { header: "Role", value: (w) => w.role },
        { header: "ID", value: (w) => out.dim(w.id) },
      ]),
    );
  }),
).pipe(Command.withDescription("List the workspaces you belong to."));

const workspaceUse = Command.make(
  "use",
  { workspace: Argument.String("workspace").pipe(Argument.withDescription("Slug or ID.")) },
  ({ workspace }) =>
    Effect.gen(function* () {
      const api = yield* client;
      const found = yield* api.workspaces.find(workspace);
      yield* updateConfig((config) => ({
        ...config,
        workspace: { id: found.id, name: found.name, slug: found.slug },
      }));
      yield* out.success(`Now using ${found.name} (${found.slug}).`);
    }),
).pipe(Command.withDescription("Set the workspace commands use by default."));

export const workspace = Command.make("workspace").pipe(
  Command.withDescription("List workspaces and pick the default one."),
  Command.withSubcommands([workspaceList, workspaceUse]),
);
