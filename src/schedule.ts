import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getZonedNow, resolveLocalTimeZone, runDailyDigest, type DigestOptions } from "./digest.ts";
import type { DailyScheduleState, ScheduleTickResult } from "./types.ts";

export { getZonedNow, resolveLocalTimeZone };

const CRON_TAG = "# discord-radar-daily-window";

export interface ScheduleWindowOptions {
  windowStart?: string;
  windowEnd?: string;
  timeZone?: string;
  statePath?: string;
  now?: Date;
  dateOverride?: string;
  rng?: (min: number, maxExclusive: number) => number;
}

export interface ScheduleTickOptions extends ScheduleWindowOptions {
  force?: boolean;
  digestOpts?: DigestOptions;
}

export interface CronInstallOptions extends ScheduleWindowOptions {
  repoRoot?: string;
  bunPath?: string;
}

export function parseWindowTime(hhmm: string): { normalized: string; minuteOfDay: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!match) {
    throw new Error(
      `Invalid window time "${hhmm}". Expected HH:MM in 24 hour format between 00:00 and 23:59.`
    );
  }
  const hour = Number.parseInt(match[1]!, 10);
  const minute = Number.parseInt(match[2]!, 10);
  return {
    normalized: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minuteOfDay: hour * 60 + minute,
  };
}

export function formatMinuteOfDay(minuteOfDay: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.floor(minuteOfDay)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function pickDailyTargetMinute(
  startMinute: number,
  endMinute: number,
  rng?: (min: number, maxExclusive: number) => number
): number {
  if (startMinute >= endMinute) {
    throw new Error(
      `Schedule windowStart (${formatMinuteOfDay(startMinute)}) must be earlier than windowEnd (${formatMinuteOfDay(endMinute)}).`
    );
  }
  const effectiveMax = endMinute - startMinute >= 10 ? endMinute - 10 : endMinute;
  const draw = rng ?? ((min: number, maxExclusive: number) => crypto.randomInt(min, maxExclusive));
  return draw(startMinute, effectiveMax + 1);
}

function writePrivateStateFile(filePath: string, content: string): void {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (path.basename(dirPath) === ".state") {
    try {
      fs.chmodSync(dirPath, 0o700);
    } catch {
      // Best effort directory hardening
    }
  }
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort file hardening
  }
}

function resolveWindowSettings(opts: ScheduleWindowOptions): {
  timeZone: string;
  normStart: string;
  normEnd: string;
  startMinute: number;
  endMinute: number;
  statePath: string;
} {
  const timeZone = resolveLocalTimeZone(opts.timeZone);
  const rawStart = opts.windowStart?.trim() || process.env.RADAR_WINDOW_START?.trim() || "08:00";
  const rawEnd = opts.windowEnd?.trim() || process.env.RADAR_WINDOW_END?.trim() || "18:00";
  const start = parseWindowTime(rawStart);
  const end = parseWindowTime(rawEnd);
  if (start.minuteOfDay >= end.minuteOfDay) {
    throw new Error(
      `Schedule windowStart (${start.normalized}) must be strictly earlier than windowEnd (${end.normalized}).`
    );
  }
  return {
    timeZone,
    normStart: start.normalized,
    normEnd: end.normalized,
    startMinute: start.minuteOfDay,
    endMinute: end.minuteOfDay,
    statePath: path.resolve(opts.statePath?.trim() || ".state/schedule-state.json"),
  };
}

/** Load or initialize today's random crawl slot inside the configured window. */
export function ensureDailyScheduleState(opts: ScheduleWindowOptions = {}): DailyScheduleState {
  const { timeZone, normStart, normEnd, startMinute, endMinute, statePath } =
    resolveWindowSettings(opts);
  const now = opts.now ?? new Date();
  const dateStr = opts.dateOverride?.trim() || getZonedNow(now, timeZone).dateStr;

  if (fs.existsSync(statePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<DailyScheduleState>;
      if (
        existing.date === dateStr &&
        existing.timeZone === timeZone &&
        existing.windowStart === normStart &&
        existing.windowEnd === normEnd &&
        typeof existing.targetMinute === "number" &&
        typeof existing.targetTime === "string"
      ) {
        return existing as DailyScheduleState;
      }
    } catch {
      // Regenerate clean state if corrupted
    }
  }

  const targetMinute = pickDailyTargetMinute(startMinute, endMinute, opts.rng);
  const fresh: DailyScheduleState = {
    date: dateStr,
    timeZone,
    windowStart: normStart,
    windowEnd: normEnd,
    targetMinute,
    targetTime: formatMinuteOfDay(targetMinute),
    completedAt: null,
    lastDigestMarkdownPath: null,
    lastDigestJsonPath: null,
  };
  writePrivateStateFile(statePath, `${JSON.stringify(fresh, null, 2)}\n`);
  return fresh;
}

/** Simulate random daily crawl slots over the next N days within the window. */
export function previewRandomScheduleDays(
  days: number,
  opts: ScheduleWindowOptions = {}
): Array<{
  date: string;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  targetMinute: number;
  targetTime: string;
}> {
  const { timeZone, normStart, normEnd, startMinute, endMinute } = resolveWindowSettings(opts);
  const now = opts.now ?? new Date();
  const startDate = opts.dateOverride?.trim() || getZonedNow(now, timeZone).dateStr;
  const [y, m, d] = startDate.split("-").map((v) => Number.parseInt(v, 10));
  const baseMs = Date.UTC(y!, (m! || 1) - 1, d! || 1);
  const count = Math.max(1, Math.min(31, days));

  const out: Array<{
    date: string;
    timeZone: string;
    windowStart: string;
    windowEnd: string;
    targetMinute: number;
    targetTime: string;
  }> = [];

  for (let offset = 0; offset < count; offset += 1) {
    const dateStr = new Date(baseMs + offset * 86_400_000).toISOString().slice(0, 10);
    const targetMinute = pickDailyTargetMinute(startMinute, endMinute, opts.rng);
    out.push({
      date: dateStr,
      timeZone,
      windowStart: normStart,
      windowEnd: normEnd,
      targetMinute,
      targetTime: formatMinuteOfDay(targetMinute),
    });
  }
  return out;
}

/** Check whether the current time matches today's randomized slot and run once per day. */
export async function runScheduleTick(
  opts: ScheduleTickOptions = {}
): Promise<ScheduleTickResult> {
  const { timeZone, startMinute, endMinute, statePath } = resolveWindowSettings(opts);
  const now = opts.now ?? new Date();
  const zoned = getZonedNow(now, timeZone);
  const state = ensureDailyScheduleState({
    ...opts,
    now,
    dateOverride: zoned.dateStr,
  });

  if (!opts.force) {
    if (zoned.minuteOfDay < startMinute || zoned.minuteOfDay > endMinute) {
      return {
        action: "outside_window",
        nowDate: zoned.dateStr,
        nowTime: zoned.timeStr,
        state,
      };
    }
    if (state.completedAt !== null) {
      return {
        action: "already_completed_today",
        nowDate: zoned.dateStr,
        nowTime: zoned.timeStr,
        state,
      };
    }
    if (zoned.minuteOfDay < state.targetMinute) {
      return {
        action: "waiting_for_slot",
        nowDate: zoned.dateStr,
        nowTime: zoned.timeStr,
        state,
      };
    }
  }

  const digest = await runDailyDigest({
    ...opts.digestOpts,
    timeZone,
    dateOverride: zoned.dateStr,
    now,
  });

  const completedAt = now.toISOString();
  const updatedState: DailyScheduleState = {
    ...state,
    completedAt,
    lastDigestMarkdownPath: digest.markdownPath,
    lastDigestJsonPath: digest.jsonPath,
  };
  writePrivateStateFile(statePath, `${JSON.stringify(updatedState, null, 2)}\n`);

  const historyPath = path.join(path.dirname(statePath), "schedule-history.jsonl");
  const historyRow = JSON.stringify({
    date: updatedState.date,
    timeZone: updatedState.timeZone,
    targetTime: updatedState.targetTime,
    executedAt: completedAt,
    executedLocalTime: zoned.timeStr,
    inserted: digest.ingest.inserted,
    processedFiles: digest.ingest.processedFiles.length,
    markdownPath: digest.markdownPath,
  });
  const dirPath = path.dirname(historyPath);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.appendFileSync(historyPath, `${historyRow}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(historyPath, 0o600);
  } catch {
    // Best effort file permission hardening
  }

  return {
    action: "executed",
    nowDate: zoned.dateStr,
    nowTime: zoned.timeStr,
    state: updatedState,
    digest,
  };
}

/** Build the 5 minute polling cron entry restricted to the active hour range. */
export function buildCronEntry(opts: CronInstallOptions = {}): string {
  const { timeZone, normStart, normEnd, startMinute, endMinute } = resolveWindowSettings(opts);
  const startHour = Math.floor(startMinute / 60);
  const endHour = Math.floor(endMinute / 60);
  const repoRoot = path.resolve(opts.repoRoot?.trim() || process.cwd());
  const bunPath = opts.bunPath?.trim() || process.execPath;
  const logPath = path.join(repoRoot, ".state", "schedule.log");

  return `*/5 ${startHour}-${endHour} * * * cd "${repoRoot}" && "${bunPath}" run src/cli.ts schedule --tick --window-start ${normStart} --window-end ${normEnd} --tz "${timeZone}" >> "${logPath}" 2>&1 ${CRON_TAG}`;
}

function readCurrentCrontab(): string[] {
  const res = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (res.status !== 0) {
    const errText = `${res.stderr ?? ""}${res.stdout ?? ""}`.toLowerCase();
    if (errText.includes("no crontab")) {
      return [];
    }
    throw new Error(`Unable to read crontab: ${res.stderr || res.error?.message || "unknown error"}`);
  }
  return (res.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function writeCrontab(lines: string[]): void {
  const dir = path.resolve(".state");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const res = spawnSync("crontab", ["-"], {
    input: payload,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`Unable to write crontab: ${res.stderr || res.error?.message || "unknown error"}`);
  }
}

/** Install or update the daily random window cron entry without removing existing cron jobs. */
export function installCronSchedule(opts: CronInstallOptions = {}): {
  installed: true;
  cronLine: string;
  preservedEntries: number;
  state: DailyScheduleState;
} {
  const cronLine = buildCronEntry(opts);
  const existing = readCurrentCrontab().filter((line) => !line.includes(CRON_TAG));
  writeCrontab([...existing, cronLine]);
  const state = ensureDailyScheduleState(opts);
  return {
    installed: true,
    cronLine,
    preservedEntries: existing.length,
    state,
  };
}

/** Remove the discord-radar cron entry while keeping all other crontab lines intact. */
export function uninstallCronSchedule(): {
  removed: number;
  remainingEntries: number;
} {
  const all = readCurrentCrontab();
  const kept = all.filter((line) => !line.includes(CRON_TAG));
  const removed = all.length - kept.length;
  if (removed > 0) {
    writeCrontab(kept);
  }
  return {
    removed,
    remainingEntries: kept.length,
  };
}
