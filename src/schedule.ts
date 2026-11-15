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
  intervalDays?: number;
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

function parseDateUtcMs(dateStr: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) {
    throw new Error(`Invalid YYYY-MM-DD date string "${dateStr}".`);
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  return Date.UTC(year, month - 1, day);
}

/** Add whole calendar days to a YYYY-MM-DD date string in UTC calendar arithmetic. */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const ms = parseDateUtcMs(dateStr) + Math.floor(days) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function readExistingScheduleState(statePath: string): Partial<DailyScheduleState> | null {
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<DailyScheduleState>;
  } catch {
    return null;
  }
}

function resolveLastCompletedDate(
  existing: Partial<DailyScheduleState> | null,
  statePath: string,
  currentDateStr: string
): string | null {
  const candidates: string[] = [];
  if (
    existing?.completedAt &&
    typeof existing.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(existing.date) &&
    existing.date <= currentDateStr
  ) {
    candidates.push(existing.date);
  }
  if (
    typeof existing?.lastCompletedDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(existing.lastCompletedDate) &&
    existing.lastCompletedDate <= currentDateStr
  ) {
    candidates.push(existing.lastCompletedDate);
  }

  const historyPath = path.join(path.dirname(statePath), "schedule-history.jsonl");
  if (fs.existsSync(historyPath)) {
    try {
      const lines = fs.readFileSync(historyPath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { date?: unknown };
          if (
            typeof parsed.date === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) &&
            parsed.date <= currentDateStr
          ) {
            candidates.push(parsed.date);
          }
        } catch {
          // Skip malformed history rows cleanly
        }
      }
    } catch {
      // Ignore unreadable history log
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.localeCompare(a));
  return candidates[0] ?? null;
}

function resolveWindowSettings(opts: ScheduleWindowOptions): {
  timeZone: string;
  normStart: string;
  normEnd: string;
  startMinute: number;
  endMinute: number;
  intervalDays: number;
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
  const envInterval = Number.parseInt(process.env.RADAR_INTERVAL_DAYS?.trim() || "", 10);
  const rawInterval =
    typeof opts.intervalDays === "number" && Number.isFinite(opts.intervalDays)
      ? opts.intervalDays
      : Number.isFinite(envInterval)
        ? envInterval
        : 2;
  const intervalDays = Math.max(1, Math.floor(rawInterval));
  return {
    timeZone,
    normStart: start.normalized,
    normEnd: end.normalized,
    startMinute: start.minuteOfDay,
    endMinute: end.minuteOfDay,
    intervalDays,
    statePath: path.resolve(opts.statePath?.trim() || ".state/schedule-state.json"),
  };
}

/** Load or initialize today's random crawl slot inside the configured window and interval. */
export function ensureDailyScheduleState(opts: ScheduleWindowOptions = {}): DailyScheduleState {
  const { timeZone, normStart, normEnd, startMinute, endMinute, intervalDays, statePath } =
    resolveWindowSettings(opts);
  const now = opts.now ?? new Date();
  const dateStr = opts.dateOverride?.trim() || getZonedNow(now, timeZone).dateStr;
  const existing = readExistingScheduleState(statePath);
  const lastCompletedDate = resolveLastCompletedDate(existing, statePath, dateStr);
  const nextEligibleDate = lastCompletedDate
    ? addDaysToDateStr(lastCompletedDate, intervalDays)
    : dateStr;

  if (
    existing &&
    existing.date === dateStr &&
    existing.timeZone === timeZone &&
    existing.windowStart === normStart &&
    existing.windowEnd === normEnd &&
    typeof existing.targetMinute === "number" &&
    typeof existing.targetTime === "string"
  ) {
    if (
      existing.intervalDays === intervalDays &&
      existing.lastCompletedDate === lastCompletedDate &&
      existing.nextEligibleDate === nextEligibleDate
    ) {
      return existing as DailyScheduleState;
    }
    const upgraded: DailyScheduleState = {
      date: existing.date,
      timeZone: existing.timeZone,
      windowStart: existing.windowStart,
      windowEnd: existing.windowEnd,
      intervalDays,
      targetMinute: existing.targetMinute,
      targetTime: existing.targetTime,
      lastCompletedDate,
      nextEligibleDate,
      completedAt: existing.completedAt ?? null,
      lastDigestMarkdownPath: existing.lastDigestMarkdownPath ?? null,
      lastDigestJsonPath: existing.lastDigestJsonPath ?? null,
    };
    writePrivateStateFile(statePath, `${JSON.stringify(upgraded, null, 2)}\n`);
    return upgraded;
  }

  const targetMinute = pickDailyTargetMinute(startMinute, endMinute, opts.rng);
  const fresh: DailyScheduleState = {
    date: dateStr,
    timeZone,
    windowStart: normStart,
    windowEnd: normEnd,
    intervalDays,
    targetMinute,
    targetTime: formatMinuteOfDay(targetMinute),
    lastCompletedDate,
    nextEligibleDate,
    completedAt: null,
    lastDigestMarkdownPath: null,
    lastDigestJsonPath: null,
  };
  writePrivateStateFile(statePath, `${JSON.stringify(fresh, null, 2)}\n`);
  return fresh;
}

/** Simulate random crawl slots over upcoming eligible days within the window and interval. */
export function previewRandomScheduleDays(
  days: number,
  opts: ScheduleWindowOptions = {}
): Array<{
  date: string;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  intervalDays: number;
  targetMinute: number;
  targetTime: string;
}> {
  const { timeZone, normStart, normEnd, startMinute, endMinute, intervalDays, statePath } =
    resolveWindowSettings(opts);
  const now = opts.now ?? new Date();
  const startDate = opts.dateOverride?.trim() || getZonedNow(now, timeZone).dateStr;
  const existing = readExistingScheduleState(statePath);
  const lastCompleted = resolveLastCompletedDate(existing, statePath, startDate);
  const nextEligible = lastCompleted ? addDaysToDateStr(lastCompleted, intervalDays) : startDate;
  const anchorDate = nextEligible > startDate ? nextEligible : startDate;
  const count = Math.max(1, Math.min(31, days));

  const out: Array<{
    date: string;
    timeZone: string;
    windowStart: string;
    windowEnd: string;
    intervalDays: number;
    targetMinute: number;
    targetTime: string;
  }> = [];

  for (let offset = 0; offset < count; offset += 1) {
    const dateStr = addDaysToDateStr(anchorDate, offset * intervalDays);
    const targetMinute = pickDailyTargetMinute(startMinute, endMinute, opts.rng);
    out.push({
      date: dateStr,
      timeZone,
      windowStart: normStart,
      windowEnd: normEnd,
      intervalDays,
      targetMinute,
      targetTime: formatMinuteOfDay(targetMinute),
    });
  }
  return out;
}

/** Check whether today is eligible on the cadence and inside the randomized window. */
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
    if (state.nextEligibleDate && zoned.dateStr < state.nextEligibleDate) {
      return {
        action: "cooldown_interval",
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
    onlyUncrawled: opts.digestOpts?.onlyUncrawled ?? true,
    timeZone,
    dateOverride: zoned.dateStr,
    now,
  });

  const completedAt = now.toISOString();
  const nextEligibleDate = addDaysToDateStr(zoned.dateStr, state.intervalDays);
  const updatedState: DailyScheduleState = {
    ...state,
    lastCompletedDate: zoned.dateStr,
    nextEligibleDate,
    completedAt,
    lastDigestMarkdownPath: digest.markdownPath,
    lastDigestJsonPath: digest.jsonPath,
  };
  writePrivateStateFile(statePath, `${JSON.stringify(updatedState, null, 2)}\n`);

  const historyPath = path.join(path.dirname(statePath), "schedule-history.jsonl");
  const historyRow = JSON.stringify({
    date: updatedState.date,
    timeZone: updatedState.timeZone,
    intervalDays: updatedState.intervalDays,
    nextEligibleDate: updatedState.nextEligibleDate,
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
  const { timeZone, normStart, normEnd, startMinute, endMinute, intervalDays } =
    resolveWindowSettings(opts);
  const startHour = Math.floor(startMinute / 60);
  const endHour = Math.floor(endMinute / 60);
  const repoRoot = path.resolve(opts.repoRoot?.trim() || process.cwd());
  const bunPath = opts.bunPath?.trim() || process.execPath;
  const logPath = path.join(repoRoot, ".state", "schedule.log");

  return `*/5 ${startHour}-${endHour} * * * cd "${repoRoot}" && "${bunPath}" run src/cli.ts schedule --tick --interval-days ${intervalDays} --only-new --window-start ${normStart} --window-end ${normEnd} --tz "${timeZone}" >> "${logPath}" 2>&1 ${CRON_TAG}`;
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
