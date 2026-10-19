// Stores the iPhone's Reminders snapshot and the queue of changes waiting for the iPhone to apply.
//
// Apple exposes no cloud API for modern Reminders lists, so an iOS Shortcut on the owner's phone
// posts a snapshot of open reminders and picks up queued commands. Everything here is plain KV
// bookkeeping; nothing touches Apple's servers.

export interface ReminderItem {
  id: string;
  title: string;
  list: string;
  due?: string;
  priority: "none" | "low" | "medium" | "high";
  flagged: boolean;
  completed: boolean;
  notes?: string;
}

export interface Snapshot {
  syncedAt: string;
  items: ReminderItem[];
}

export interface CreateCommand {
  id: string;
  kind: "create";
  queuedAt: string;
  title: string;
  list?: string;
  due?: string;
  notes?: string;
  priority?: "none" | "low" | "medium" | "high";
}

export type Command = CreateCommand;

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const SNAPSHOT_KEY = "reminders:snapshot";
export const COMMANDS_KEY = "reminders:commands";
export const FIELD_SEPARATOR = "|||";
const MAX_ITEMS = 5000;
const MAX_COMMANDS = 200;
const MAX_FIELD = 20_000;

export function normalizePriority(value: string | undefined): ReminderItem["priority"] {
  const text = (value ?? "").trim().toLowerCase();
  if (text === "low" || text === "1" || text === "9") return "low";
  if (text === "medium" || text === "5") return "medium";
  if (text === "high" || text === "!!!" || text === "2" || text === "3" || text === "4") return "high";
  return "none";
}

function normalizeBoolean(value: string | undefined): boolean {
  const text = (value ?? "").trim().toLowerCase();
  return text === "yes" || text === "true" || text === "1";
}

const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_NO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

// Offset of `timeZone` from UTC, in minutes, at the given instant.
function zoneOffsetMinutes(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at) / 60_000);
}

// Interprets a wall-clock time (expressed as UTC fields) in `timeZone` and returns the real instant.
function wallClockToInstant(wallClockAsUtc: number, timeZone: string): number {
  let instant = wallClockAsUtc - zoneOffsetMinutes(timeZone, wallClockAsUtc) * 60_000;
  instant = wallClockAsUtc - zoneOffsetMinutes(timeZone, instant) * 60_000;
  return instant;
}

function validZone(timeZone: string | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return "UTC";
  }
}

// Normalizes a due date to an ISO instant. Accepts ISO with an offset, a plain date, and the text the
// iOS Shortcuts app produces by default for a date, such as "Oct 20, 2026 at 2:00 PM"; text without an
// offset is read as wall-clock time in `timeZone` (the calendar's default zone), never as UTC.
export function normalizeDue(value: string | undefined, timeZone = "UTC"): string | undefined {
  const text = (value ?? "").trim();
  if (!text) return undefined;
  const zone = validZone(timeZone);
  if (DATE_ONLY.test(text)) {
    return new Date(wallClockToInstant(Date.parse(`${text}T00:00:00Z`), zone)).toISOString();
  }
  if (EXPLICIT_OFFSET.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? text.slice(0, 64) : parsed.toISOString();
  }
  if (ISO_NO_OFFSET.test(text)) {
    return new Date(wallClockToInstant(Date.parse(`${text}Z`), zone)).toISOString();
  }
  const cleaned = text.replace(/\s+at\s+/i, " ").replace(/\u202f|\u00a0/g, " ");
  let asUtc = Date.parse(`${cleaned} UTC`);
  // The runtime's "local" zone is UTC, so a lenient parse without a zone also yields wall-clock-as-UTC.
  if (Number.isNaN(asUtc)) asUtc = Date.parse(cleaned);
  if (Number.isNaN(asUtc)) return text.slice(0, 64);
  return new Date(wallClockToInstant(asUtc, zone)).toISOString();
}

async function stableId(parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join("\u0000"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Parses the Shortcut's text payload. One reminder per line:
//   title ||| list ||| due ||| priority ||| flagged ||| notes [||| completed]
// A line with fewer than two separators is treated as a continuation of the previous reminder's notes,
// so multi-line notes survive without extra work in the Shortcut.
export async function parseSnapshotPayload(payload: string, timeZone = "UTC"): Promise<ReminderItem[]> {
  const items: ReminderItem[] = [];
  let pendingNotes: string[] = [];
  let current: Omit<ReminderItem, "id"> | undefined;

  const flush = async () => {
    if (!current) return;
    const notes = [current.notes ?? "", ...pendingNotes].join("\n").trim();
    const { notes: _ignored, ...rest } = current;
    const item: ReminderItem = {
      ...rest,
      ...(notes ? { notes: notes.slice(0, MAX_FIELD) } : {}),
      id: await stableId([current.list, current.title, current.due ?? ""]),
    };
    items.push(item);
    current = undefined;
    pendingNotes = [];
  };

  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length < 3) {
      if (current) pendingNotes.push(line);
      continue;
    }
    await flush();
    const [title = "", list = "", due, priority, flagged, notes, completed] = fields.map((field) => field.trim());
    if (!title) continue;
    const dueValue = normalizeDue(due, timeZone);
    current = {
      title: title.slice(0, 1000),
      list: (list || "Reminders").slice(0, 200),
      ...(dueValue ? { due: dueValue } : {}),
      priority: normalizePriority(priority),
      flagged: normalizeBoolean(flagged),
      completed: normalizeBoolean(completed),
      ...(notes ? { notes } : {}),
    };
    if (items.length >= MAX_ITEMS) break;
  }
  await flush();
  return items;
}

export async function readSnapshot(kv: KvLike): Promise<Snapshot | undefined> {
  const raw = await kv.get(SNAPSHOT_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Snapshot;
    if (!parsed || !Array.isArray(parsed.items) || typeof parsed.syncedAt !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeSnapshot(kv: KvLike, items: ReminderItem[], now = new Date()): Promise<Snapshot> {
  const snapshot: Snapshot = { syncedAt: now.toISOString(), items: items.slice(0, MAX_ITEMS) };
  await kv.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function readCommands(kv: KvLike): Promise<Command[]> {
  const raw = await kv.get(COMMANDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Command[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function queueCreate(
  kv: KvLike,
  input: { title: string; list?: string | undefined; due?: string | undefined; notes?: string | undefined; priority?: ReminderItem["priority"] | undefined },
  now = new Date(),
  timeZone = "UTC",
): Promise<CreateCommand> {
  const commands = await readCommands(kv);
  if (commands.length >= MAX_COMMANDS) {
    throw new Error("Too many reminder changes are waiting for the iPhone to sync. Open Reminders on the iPhone or run the sync Shortcut, then try again.");
  }
  const due = input.due ? normalizeDue(input.due, timeZone) : undefined;
  const command: CreateCommand = {
    id: crypto.randomUUID(),
    kind: "create",
    queuedAt: now.toISOString(),
    title: input.title.trim().slice(0, 1000),
    ...(input.list?.trim() ? { list: input.list.trim().slice(0, 200) } : {}),
    ...(due ? { due } : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, MAX_FIELD) } : {}),
    ...(input.priority && input.priority !== "none" ? { priority: input.priority } : {}),
  };
  commands.push(command);
  await kv.put(COMMANDS_KEY, JSON.stringify(commands));
  return command;
}

// Hands every queued command to the iPhone and removes exactly those commands, so anything
// queued while the sync was in flight survives for the next one.
export async function drainCommands(kv: KvLike): Promise<Command[]> {
  const delivered = await readCommands(kv);
  if (delivered.length === 0) return [];
  const deliveredIds = new Set(delivered.map((command) => command.id));
  const remaining = (await readCommands(kv)).filter((command) => !deliveredIds.has(command.id));
  await kv.put(COMMANDS_KEY, JSON.stringify(remaining));
  return delivered;
}

export function ageMinutes(snapshot: Snapshot, now = new Date()): number {
  return Math.max(0, Math.round((now.getTime() - new Date(snapshot.syncedAt).getTime()) / 60_000));
}
