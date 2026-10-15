// Nightly product totals: the activation funnel, engagement and feedback, worked out from records
// the gateway already keeps (profiles, Gmail connections, run records, feedback). Only totals are
// saved and emitted: no user IDs, queries or anything about an email.

import { emit } from "./metrics";
import type { Item, Table } from "./store/table";

export type DailyStats = Record<string, number>;

const DAY = 86400000;

/** Totals for the 24 hours before `now` (and 7/30-day activity), from every item in the table. */
export function dailyStats(items: Item[], now: Date): DailyStats {
  const t = now.getTime();
  const within = (iso: unknown, ms: number) => {
    const x = Date.parse(String(iso ?? ""));
    return Number.isFinite(x) && x <= t && x > t - ms;
  };
  const created = new Map<string, number>();
  const connected = new Set<string>();
  const runsBy = new Map<string, number[]>();
  const s: DailyStats = {
    searches_1d: 0, reads_1d: 0, emails_1d: 0, shared_1d: 0, redacted_1d: 0, withheld_1d: 0,
    claude_runs_1d: 0, chatgpt_runs_1d: 0, other_assistant_runs_1d: 0, background_runs_1d: 0,
    feedback_release_1d: 0, feedback_keep_1d: 0, feedback_leak_1d: 0,
  };
  for (const it of items) {
    if (!it.pk.startsWith("USER#")) continue;
    const user = it.pk;
    if (it.sk === "PROFILE") created.set(user, Date.parse(String(it.createdAt ?? "")) || 0);
    else if (it.sk === "GMAIL") connected.add(user);
    else if (it.sk.startsWith("RUN#")) {
      const at = Date.parse(String(it.createdAt ?? ""));
      if (!Number.isFinite(at)) continue;
      (runsBy.get(user) ?? runsBy.set(user, []).get(user)!).push(at);
      if (!within(it.createdAt, DAY)) continue;
      if (it.tool === "search_email") s.searches_1d!++;
      else s.reads_1d!++;
      const shared = Number(it.shared ?? 0), redacted = Number(it.redacted ?? 0), withheld = Number(it.withheld ?? 0);
      s.shared_1d! += shared;
      s.redacted_1d! += redacted;
      s.withheld_1d! += withheld;
      s.emails_1d! += shared + redacted + withheld;
      if (it.assistant === "claude") s.claude_runs_1d!++;
      else if (it.assistant === "chatgpt") s.chatgpt_runs_1d!++;
      else s.other_assistant_runs_1d!++;
      if (it.runType === "background_likely") s.background_runs_1d!++;
    } else if (it.sk.startsWith("FEEDBACK#") && within(it.at, DAY)) {
      const k = `feedback_${String(it.decision)}_1d`;
      if (k in s) s[k]!++;
    }
  }
  const activeWithin = (ms: number) => [...runsBy.values()].filter((xs) => xs.some((x) => x <= t && x > t - ms)).length;
  // Week-2 retention: users who signed up 7-14 days ago and used an assistant in the last 7 days.
  const cohort = [...created].filter(([, c]) => c <= t - 7 * DAY && c > t - 14 * DAY).map(([u]) => u);
  const retained = cohort.filter((u) => (runsBy.get(u) ?? []).some((x) => x > t - 7 * DAY && x <= t)).length;
  return {
    // Funnel: signed up → Gmail connected → used from an assistant (any run kept, 90 days) → active.
    users_total: created.size,
    users_new_1d: [...created.values()].filter((c) => c <= t && c > t - DAY).length,
    gmail_connected: connected.size,
    used_from_assistant: [...runsBy.keys()].filter((u) => created.has(u)).length,
    active_1d: activeWithin(DAY),
    active_7d: activeWithin(7 * DAY),
    active_30d: activeWithin(30 * DAY),
    week2_cohort: cohort.length,
    week2_retained: retained,
    ...s,
  };
}

/** Computes yesterday's totals, saves them under STATS (kept 400 days) and emits them as metrics. */
export async function runDailyStats(table: Table, now = new Date()): Promise<DailyStats> {
  const stats = dailyStats(await table.scan(), now);
  const day = now.toISOString().slice(0, 10);
  await table.put({ pk: "STATS", sk: `DAY#${day}`, ...stats, at: now.toISOString(), expiresAt: Math.floor(now.getTime() / 1000) + 400 * 86400 });
  for (const [stat, value] of Object.entries(stats)) emit([{ name: "Daily", value }], { Stat: stat });
  return stats;
}
