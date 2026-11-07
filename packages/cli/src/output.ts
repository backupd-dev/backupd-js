/**
 * Terminal output. Results go to stdout (a table, or JSON with --json);
 * progress and hints go to stderr, so `backupd … --json | jq` stays clean.
 */
import { Console, Effect } from "effect";

const colorEnabled = (): boolean =>
  !process.env.NO_COLOR && process.env.TERM !== "dumb" && Boolean(process.stderr.isTTY);

const paint =
  (open: number, close: number) =>
  (text: string): string =>
    colorEnabled() ? `\u001B[${open}m${text}\u001B[${close}m` : text;

export const bold = paint(1, 22);
export const dim = paint(2, 22);
export const green = paint(32, 39);
export const red = paint(31, 39);
export const yellow = paint(33, 39);
export const cyan = paint(36, 39);

/** A line of progress or a hint, on stderr. */
export const note = (message: string) => Console.error(message);

export const success = (message: string) => Console.error(`${green("✓")} ${message}`);

export const warn = (message: string) => Console.error(`${yellow("!")} ${message}`);

export const json = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

export interface Column<Row> {
  readonly header: string;
  readonly value: (row: Row) => string;
  readonly align?: "left" | "right";
}

// Strip colour codes when measuring width.
const visibleLength = (text: string): number =>
  // oxlint-disable-next-line no-control-regex -- matching ANSI escapes on purpose.
  text.replaceAll(/\u001B\[[0-9;]*m/gu, "").length;

const pad = (text: string, width: number, align: "left" | "right"): string => {
  const gap = " ".repeat(Math.max(0, width - visibleLength(text)));
  return align === "right" ? gap + text : text + gap;
};

/** A plain, aligned table on stdout. Prints `empty` when there are no rows. */
export const table = <Row>(
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<Column<Row>>,
  empty = "Nothing here yet.",
) => {
  if (rows.length === 0) {
    return note(dim(empty));
  }
  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, index) =>
    Math.max(
      visibleLength(column.header),
      ...cells.map((line) => visibleLength(line[index] ?? "")),
    ),
  );
  const render = (line: ReadonlyArray<string>) =>
    line
      .map((cell, index) => pad(cell, widths[index] ?? 0, columns[index]?.align ?? "left"))
      .join("  ")
      .trimEnd();
  const header = render(columns.map((column) => dim(column.header)));
  return Console.log([header, ...cells.map(render)].join("\n"));
};

/** Key/value lines, aligned, on stdout. */
export const details = (pairs: ReadonlyArray<readonly [string, string]>) => {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return Console.log(pairs.map(([key, value]) => `${dim(key.padEnd(width))}  ${value}`).join("\n"));
};

/** `either` prints JSON when asked, otherwise runs the human renderer. */
export const either = (asJson: boolean, value: unknown, human: Effect.Effect<void>) =>
  asJson ? json(value) : human;

export const bytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined) {
    return "–";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
};

/** "12 minutes ago", "in 3 hours". */
export const ago = (iso: string | null | undefined): string => {
  if (!iso) {
    return "–";
  }
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const steps: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  let amount = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(amount) < size) {
      return format.format(Math.round(amount), unit);
    }
    amount /= size;
  }
  return iso;
};
