import type { CollectionError, Snapshot, StalenessVerdict } from "@404sl/pitwall-schema";
import {
  LANE_CHIP_LIMIT,
  buildBoard,
  readyByProject,
  type Board,
  type LaneChip,
  type NeedsYouGroup,
  type ParkedEntry,
  type ProblemRow,
  type RunningRow,
  type RunningState,
  type RunningTotal,
} from "./board.js";
import { elapsed, fill, priorityLabel } from "./format.js";
import { characterColumns, displayWidth } from "./width.js";

export const READY_PER_PROJECT = 3;
export const SNAPSHOT_STALE_AFTER_MS = 10 * 60_000;

const QUALIFY_AFTER_MS = 60_000;

export type StatusArgs = { from?: string } | { error: string };

export interface StatusOptions {
  color?: boolean;
  width?: number;
  now?: number;
  fromFile?: boolean;
}

const NO_PROJECTS = "No projects to report.";
const NO_PROJECT_REASON = "Nothing in this snapshot names a workspace root, and nothing recorded why.";
const NO_SNAPSHOT = "No snapshot to show yet - {source} could not be read: {message}";

const AGE = {
  header: "{age} ago",
  stale: "{age} old",
  refresh: " · run pitwall snapshot to refresh",
  asOf: " · as of {age} ago",
};

const EMPTY = {
  needsYou: "Nothing needs you.",
  running: "No lane is running.",
  ready: "Nothing is ready to pick up.",
  parked: "Nothing parked.",
  problems: "Every project read cleanly.",
};

const VERDICT_WORD: Record<StalenessVerdict, string> = {
  unchecked: "unchecked",
  "still-blocking": "still blocking",
  "likely-stale": "likely stale",
  resolved: "resolved",
};

const VERDICT_COLOUR: Record<StalenessVerdict, string> = {
  unchecked: "2",
  "still-blocking": "33",
  "likely-stale": "36",
  resolved: "32",
};

const STATE_WORD: Record<RunningState, string> = {
  working: "working",
  "awaiting-lander": "awaiting lander",
  stranded: "stranded",
};

const STATE_COLOUR: Record<RunningState, string> = {
  working: "32",
  "awaiting-lander": "36",
  stranded: "31",
};

type Paint = (text: string, code: string) => string;

const SGR = /\u001b\[[0-9;]*m/g;
const SGR_PART = /(\u001b\[[0-9;]*m)/;
const ELLIPSIS = "\u2026";
const MIN_WIDTH = 20;

function plainWidth(text: string): number {
  return displayWidth(text.replace(SGR, ""));
}

function clip(text: string, budget: number): string {
  let left = budget;
  let out = "";
  for (const part of text.split(SGR_PART)) {
    if (part.startsWith("\u001b")) {
      out += part;
      continue;
    }
    for (const character of part) {
      const columns = characterColumns(character);
      if (columns > left) {
        left = 0;
        break;
      }
      out += character;
      left -= columns;
    }
  }
  return out;
}

function usableWidth(width: number | undefined): number | undefined {
  return width !== undefined && width >= MIN_WIDTH ? width : undefined;
}

function fit(prefix: string, tail: string, width: number | undefined): string {
  if (width === undefined) {
    return `${prefix}${tail}`;
  }
  const budget = width - plainWidth(prefix);
  if (budget < 1 || plainWidth(tail) <= budget) {
    return `${prefix}${tail}`;
  }
  return `${prefix}${clip(tail, budget - 1).trimEnd()}${ELLIPSIS}`;
}

export function terminalWidth(stdout: { isTTY?: boolean; columns?: number }): number | undefined {
  return stdout.isTTY === true ? stdout.columns : undefined;
}

export function wantsColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  const disabled = env.NO_COLOR;
  if (disabled !== undefined && disabled !== "") {
    return false;
  }
  return isTTY;
}

export function parseStatusArgs(argv: string[]): StatusArgs {
  const tokens = argv.flatMap((arg) =>
    arg.startsWith("--from=") ? ["--from", arg.slice("--from=".length)] : [arg],
  );
  let from: string | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token !== "--from") {
      return { error: `unknown argument ${token}` };
    }
    const value = tokens[i + 1];
    if (value === undefined || value === "") {
      return { error: "--from expects a path, got nothing" };
    }
    from = value;
    i += 1;
  }
  return from === undefined ? {} : { from };
}

export function painter(color: boolean): Paint {
  return (text, code) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
}

function widest(values: string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function section(paint: Paint, label: string, count: string | undefined, body: string[]): string[] {
  const head = paint(label.toUpperCase(), "1");
  return ["", count === undefined ? head : `${head} ${paint(count, "2")}`, ...body];
}

function needsYouLines(groups: NeedsYouGroup[], paint: Paint, width: number | undefined): string[] {
  if (groups.length === 0) {
    return [`  ${EMPTY.needsYou}`];
  }
  const rows = groups.flatMap((group) => group.rows);
  const idWidth = widest(rows.map((row) => row.id));
  const priorityWidth = widest(rows.map((row) => priorityLabel(row.priority)));
  const kindWidth = widest(rows.map((row) => row.kind));
  const verdictWidth = widest(rows.map((row) => VERDICT_WORD[row.verdict]));
  return groups.flatMap((group) => [
    `  ${paint(group.project, "1")}`,
    ...group.rows.map((row) => {
      const columns = [
        "   ",
        paint(row.id.padEnd(idWidth), "36"),
        priorityLabel(row.priority).padEnd(priorityWidth),
        row.kind.padEnd(kindWidth),
        paint(VERDICT_WORD[row.verdict].padEnd(verdictWidth), VERDICT_COLOUR[row.verdict]),
      ].join(" ");
      return fit(`${columns} `, row.title, width);
    }),
  ]);
}

function chipText(chip: LaneChip): string {
  const id = chip.id ?? `lane ${chip.slot}`;
  return `${id} ${chip.elapsedMs === undefined ? "—" : elapsed(chip.elapsedMs)}`;
}

function chipsText(chips: LaneChip[]): string {
  const shown = chips.slice(0, LANE_CHIP_LIMIT);
  const rest = chips.length - shown.length;
  const text = shown.map(chipText).join(" · ");
  if (rest === 0) {
    return text;
  }
  return text === "" ? `+${rest} more` : `${text} · +${rest} more`;
}

function stateText(row: RunningRow): string {
  return `${row.count} ${STATE_WORD[row.state]}`;
}

function runningSummary(totals: RunningTotal[]): string {
  return totals.map((total) => `${total.count} ${STATE_WORD[total.state]}`).join(" \u00b7 ");
}

function runningLines(rows: RunningRow[], paint: Paint, width: number | undefined): string[] {
  if (rows.length === 0) {
    return [`  ${EMPTY.running}`];
  }
  const projectWidth = widest(rows.map((row) => row.project));
  const stateWidth = widest(rows.map((row) => stateText(row)));
  return rows.map((row) => {
    const state = paint(stateText(row).padEnd(stateWidth), STATE_COLOUR[row.state]);
    return fit(`  ${row.project.padEnd(projectWidth)} ${state} `, chipsText(row.chips), width).trimEnd();
  });
}

function readyLines(snapshot: Snapshot, paint: Paint, width: number | undefined): string[] {
  const groups = readyByProject(snapshot, READY_PER_PROJECT);
  if (groups.length === 0) {
    return [`  ${EMPTY.ready}`];
  }
  const rows = groups.flatMap((group) => group.rows);
  const idWidth = widest(rows.map((row) => row.id));
  const priorityWidth = widest(rows.map((row) => priorityLabel(row.priority)));
  return groups.flatMap((group) => {
    const rest = group.total - group.rows.length;
    return [
      `  ${paint(group.project, "1")}`,
      ...group.rows.map((row) => {
        const columns = ["   ", paint(row.id.padEnd(idWidth), "36"), priorityLabel(row.priority).padEnd(priorityWidth)].join(" ");
        return fit(`${columns} `, row.title, width);
      }),
      ...(rest > 0 ? [`    ${paint(`+${rest} more ready`, "2")}`] : []),
    ];
  });
}

function parkedLines(entries: ParkedEntry[], paint: Paint): string[] {
  if (entries.length === 0) {
    return [`  ${EMPTY.parked}`];
  }
  const reasonWidth = widest(entries.map((entry) => entry.reason));
  return entries.map((entry) => `  ${entry.reason.padEnd(reasonWidth)} ${paint(String(entry.count), "2")}`);
}

function problemLines(rows: ProblemRow[], paint: Paint): string[] {
  if (rows.length === 0) {
    return [`  ${EMPTY.problems}`];
  }
  const nameWidth = widest(rows.map((row) => row.name));
  const sourceWidth = widest(rows.map((row) => row.source));
  return rows.map(
    (row) => `  ${paint(row.name.padEnd(nameWidth), "31")} ${row.source.padEnd(sourceWidth)} ${row.message}`,
  );
}

function ageOf(generatedAt: string, now: number): number | undefined {
  const at = Date.parse(generatedAt);
  return Number.isNaN(at) ? undefined : Math.max(0, now - at);
}

function header(board: Board, ageMs: number | undefined, paint: Paint, width: number | undefined): string {
  const noun = board.projectCount === 1 ? "project" : "projects";
  const age = ageMs === undefined ? "" : `${paint(fill(AGE.header, { age: elapsed(ageMs) }), "2")} · `;
  const prefix = `${paint("pitwall", "1")} · ${board.projectCount} ${noun} · ${age}`;
  const stamped = paint(board.generatedAt, "2");
  if (width !== undefined && plainWidth(prefix) + plainWidth(stamped) > width) {
    return prefix.slice(0, -3);
  }
  return `${prefix}${stamped}`;
}

function staleLine(ageMs: number, fromFile: boolean, paint: Paint, width: number | undefined): string {
  const remedy = fromFile ? "" : AGE.refresh;
  return fit(`${paint("STALE", "1;33")} `, `${fill(AGE.stale, { age: elapsed(ageMs) })}${remedy}`, width);
}

function runningCount(board: Board, ageMs: number | undefined, width: number | undefined): string | undefined {
  if (board.running.length === 0) {
    return undefined;
  }
  const counts = runningSummary(board.runningTotals);
  if (ageMs === undefined || ageMs < QUALIFY_AFTER_MS) {
    return counts;
  }
  const qualified = `${counts}${fill(AGE.asOf, { age: elapsed(ageMs) })}`;
  if (width !== undefined && "RUNNING ".length + qualified.length > width) {
    return counts;
  }
  return qualified;
}

export function missingSnapshotMessage(error: CollectionError): string {
  return fill(NO_SNAPSHOT, { source: error.source, message: error.message });
}

export function renderStatus(snapshot: Snapshot, options: StatusOptions = {}): string {
  const paint = painter(options.color ?? false);
  const width = usableWidth(options.width);
  const board = buildBoard(snapshot);
  const ageMs = ageOf(board.generatedAt, options.now ?? Date.now());
  const lines = [header(board, ageMs, paint, width)];
  if (ageMs !== undefined && ageMs >= SNAPSHOT_STALE_AFTER_MS) {
    lines.push(staleLine(ageMs, options.fromFile ?? false, paint, width));
  }
  if (board.projectCount === 0) {
    lines.push("", NO_PROJECTS);
    lines.push(
      ...(board.problems.length === 0
        ? [`  ${NO_PROJECT_REASON}`]
        : board.problems.map((row) => `  ${row.message}`)),
    );
    return `${lines.join("\n")}\n`;
  }
  const needsCount = board.needsYouCount === 0 ? undefined : String(board.needsYouCount);
  const readyCount = board.readyCount === 0 ? undefined : String(board.readyCount);
  lines.push(...section(paint, "Needs you", needsCount, needsYouLines(board.needsYou, paint, width)));
  lines.push(
    ...section(paint, "Running", runningCount(board, ageMs, width), runningLines(board.running, paint, width)),
  );
  lines.push(...section(paint, "Ready", readyCount, readyLines(snapshot, paint, width)));
  lines.push(...section(paint, "Parked", undefined, parkedLines(board.parked, paint)));
  lines.push(...section(paint, "Problems", undefined, problemLines(board.problems, paint)));
  return `${lines.join("\n")}\n`;
}
