import * as out from "./output.js";

export interface Described {
  readonly exitCode: number;
  readonly message: string;
}

const tagOf = (error: unknown): string | undefined =>
  error && typeof error === "object" && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined;

const field = (error: unknown, key: string): unknown =>
  error && typeof error === "object" && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;

/** A human message and an exit code for anything a command can fail with. */
export const describeError = (error: unknown): Described => {
  const tag = tagOf(error);
  const message = String(field(error, "message") ?? error);
  const cross = out.red("✗");
  switch (tag) {
    case "ApiError": {
      const status = Number(field(error, "status"));
      const code = String(field(error, "code"));
      if (status === 401) {
        return {
          exitCode: 3,
          message: `${cross} ${message}. Run \`backupd login\` (or check BACKUPD_API_KEY).`,
        };
      }
      if (status === 403) {
        return { exitCode: 3, message: `${cross} ${message}` };
      }
      return { exitCode: 1, message: `${cross} ${message} ${out.dim(`(${code})`)}` };
    }
    case "ConfigError": {
      return {
        exitCode: message.includes("not logged in") ? 3 : 2,
        message: `${cross} ${message}`,
      };
    }
    case "WaitTimeout": {
      return { exitCode: 4, message: `${cross} ${message}` };
    }
    case "OperationFailed": {
      const kind = String(field(error, "kind"));
      return {
        exitCode: 1,
        message: `${cross} The ${kind} ${String(field(error, "status"))}: ${message}`,
      };
    }
    case "NetworkError":
    case "ResponseError":
    case "LocalError":
    case "Unhealthy": {
      return { exitCode: 1, message: `${cross} ${message}` };
    }
    case "QuitError": {
      return { exitCode: 130, message: "" };
    }
    default: {
      return {
        exitCode: 1,
        message: `${cross} Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : message}`,
      };
    }
  }
};
