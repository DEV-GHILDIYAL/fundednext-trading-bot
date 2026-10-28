/**
 * US tier-1 news blackout for gold (no NEW entries around the release; open trades keep their SL/TP).
 *
 *   window = 15 min before → 30 min after the release (FOMC: → 60 min after, covers the press conference)
 *
 * Sources:
 *  - built-in schedule (works offline and in the backtest): NFP = first Friday 08:30 ET, FOMC statement days 14:00 ET
 *  - live only: ForexFactory weekly calendar (USD, High impact) — adds CPI, PCE, GDP, retail sales, etc.
 *    If the feed is unreachable the built-in schedule is still applied.
 */
import { getZonedTime } from '../utils/time';

export interface NewsEvent {
  /** Release time (UTC) */
  at: Date;
  title: string;
}

export const NEWS_WINDOW = { beforeMin: 15, afterMin: 30, fomcAfterMin: 60 };

/** FOMC statement days (NY date). Statement 14:00 ET, press conference 14:30 ET. */
export const FOMC_DATES = [
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08',
];
const FOMC_SET = new Set(FOMC_DATES);

export function isFomcDay(nyDateKey: string): boolean {
  return FOMC_SET.has(nyDateKey);
}

/** UTC instant of a New York wall-clock time (DST-safe without a tz library) */
export function nyTimeToUtc(dateKey: string, hour: number, minute: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  // New York is UTC−4 (summer) or UTC−5 (winter): try both, keep the one that reads back correctly
  for (const offset of [4, 5]) {
    const guess = new Date(Date.UTC(y, m - 1, d, hour + offset, minute));
    const t = getZonedTime(guess, 'America/New_York');
    if (t.dateKey === dateKey && t.hour === hour && t.minute === minute) return guess;
  }
  return new Date(Date.UTC(y, m - 1, d, hour + 5, minute));
}

/** CPI / PPI release days (NY date, 08:30 ET) from the BLS schedule; live trading also reads them from the feed */
export const CPI_PPI_DATES: { date: string; title: string }[] = [
  { date: '2026-05-12', title: 'CPI' },
  { date: '2026-05-13', title: 'PPI' },
  { date: '2026-06-10', title: 'CPI' },
  { date: '2026-06-11', title: 'PPI' },
  { date: '2026-07-14', title: 'CPI' },
  { date: '2026-07-15', title: 'PPI' },
  { date: '2026-08-12', title: 'CPI' },
  { date: '2026-08-13', title: 'PPI' },
  { date: '2026-10-14', title: 'CPI' },
  { date: '2026-10-15', title: 'PPI' },
  { date: '2026-11-10', title: 'CPI' },
  { date: '2026-11-13', title: 'PPI' },
  { date: '2026-12-10', title: 'CPI' },
  { date: '2026-12-15', title: 'PPI' },
];

/** Actual Employment Situation (NFP) dates where BLS moved it off the first Friday; other months use the rule */
export const NFP_DATES: Record<string, string> = {
  '2026-05': '2026-05-08',
  '2026-06': '2026-06-05',
  '2026-07': '2026-07-02',
  '2026-08': '2026-08-07',
  '2026-10': '2026-10-02',
};

/** Titles that make the whole day a no-trade day for fibSweep */
export const MAJOR_NEWS = /non-?farm|payroll|\bnfp\b|\bcpi\b|\bppi\b|fomc|federal funds/i;

/** IST date keys (YYYY-MM-DD) that have a major US release (NFP, CPI, PPI, FOMC) */
export function majorNewsDays(events: NewsEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (!MAJOR_NEWS.test(e.title)) continue;
    const key = getZonedTime(e.at, 'Asia/Kolkata').dateKey;
    if (!out.has(key)) out.set(key, e.title);
  }
  return out;
}

/**
 * fibSweep news-day plan for one IST day (Dev, 28 Oct):
 *  - major release (NFP/CPI/PPI/FOMC) before 21:30 IST → skip the whole day (as before)
 *  - every major release at/after 21:30 IST (e.g. FOMC 23:30 IST) → trade normally (entries end 21:00),
 *    and close any open trade 30 min before the release
 */
export const LATE_NEWS = { fromMin: 21 * 60 + 30, closeBeforeMin: 30 };
export interface NewsDayPlan {
  /** reason to skip the day, or null */
  skip: string | null;
  /** late release today: trade, but close open trades at closeAt */
  late: { title: string; at: Date; closeAt: Date } | null;
}
export function newsDayPlan(events: NewsEvent[], now: Date): NewsDayPlan {
  const today = getZonedTime(now, 'Asia/Kolkata').dateKey;
  const major = events
    .filter((e) => MAJOR_NEWS.test(e.title) && getZonedTime(e.at, 'Asia/Kolkata').dateKey === today)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!major.length) return { skip: null, late: null };
  const first = major[0];
  if (getZonedTime(first.at, 'Asia/Kolkata').minutesOfDay < LATE_NEWS.fromMin) return { skip: `Major US news day (${first.title})`, late: null };
  return { skip: null, late: { title: first.title, at: first.at, closeAt: new Date(first.at.getTime() - LATE_NEWS.closeBeforeMin * 60000) } };
}

/** Built-in schedule between two UTC instants: NFP (first Friday 08:30 ET) + FOMC (14:00 ET) + known CPI/PPI */
export function builtInEvents(from: Date, to: Date): NewsEvent[] {
  const out: NewsEvent[] = [];
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  for (let d = start; d.getTime() <= to.getTime() + 86400000; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const firstFriday = 1 + ((5 - firstDow + 7) % 7);
    const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
    const key = NFP_DATES[ym] ?? `${ym}-${String(firstFriday).padStart(2, '0')}`;
    out.push({ at: nyTimeToUtc(key, 8, 30), title: 'Non-Farm Payrolls' });
  }
  for (const key of FOMC_DATES) out.push({ at: nyTimeToUtc(key, 14, 0), title: 'FOMC statement' });
  for (const r of CPI_PPI_DATES) out.push({ at: nyTimeToUtc(r.date, 8, 30), title: r.title });
  return out.filter((e) => e.at.getTime() >= from.getTime() - 86400000 && e.at.getTime() <= to.getTime() + 86400000);
}

/** Reason string if `utc` is inside a blackout window of any event, else null */
export function newsBlackout(utc: Date, events: NewsEvent[]): string | null {
  const t = utc.getTime();
  for (const e of events) {
    const after = /fomc|fed|powell|federal funds/i.test(e.title) ? NEWS_WINDOW.fomcAfterMin : NEWS_WINDOW.afterMin;
    if (t >= e.at.getTime() - NEWS_WINDOW.beforeMin * 60000 && t <= e.at.getTime() + after * 60000) {
      return `News blackout: ${e.title} ${e.at.toISOString().slice(11, 16)} UTC`;
    }
  }
  return null;
}

/** Backtest helper: fast lookup over a long history (events sorted once) */
export class NewsIndex {
  private times: number[];
  constructor(private events: NewsEvent[]) {
    this.events = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
    this.times = this.events.map((e) => e.at.getTime());
  }
  check(utc: Date): string | null {
    const t = utc.getTime();
    // events within ±2h are the only candidates
    let lo = 0;
    let hi = this.times.length;
    const target = t - 2 * 3600000;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const near: NewsEvent[] = [];
    for (let i = lo; i < this.events.length && this.times[i] <= t + 2 * 3600000; i++) near.push(this.events[i]);
    return newsBlackout(utc, near);
  }
}

interface FfEvent {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
}

/** Live calendar: built-in schedule + ForexFactory weekly feed (refreshed every 6 h) */
export class NewsCalendar {
  private feed: NewsEvent[] = [];
  private fetchedAt = 0;
  private lastError = '';
  constructor(
    private url: string = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    private fetcher: (url: string) => Promise<unknown> = async (u) => {
      const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }
  ) {}

  get status(): { feedEvents: number; fetchedAt: string | null; error: string } {
    return { feedEvents: this.feed.length, fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null, error: this.lastError };
  }

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.fetchedAt < 6 * 3600000) return;
    try {
      const data = (await this.fetcher(this.url)) as FfEvent[];
      if (!Array.isArray(data)) throw new Error('unexpected calendar format');
      this.feed = data
        .filter((e) => e.country === 'USD' && e.impact === 'High' && e.date && e.title)
        .map((e) => ({ at: new Date(e.date as string), title: e.title as string }))
        .filter((e) => Number.isFinite(e.at.getTime()));
      this.lastError = '';
    } catch (error) {
      this.lastError = (error as Error).message;
    }
    // retry a failed fetch after 30 min instead of 6 h
    this.fetchedAt = this.lastError ? Date.now() - 5.5 * 3600000 : Date.now();
  }

  /** Today's (IST) fibSweep news plan: skip the day, or trade with a forced close before a late release */
  async dayPlan(now: Date = new Date()): Promise<NewsDayPlan> {
    await this.refresh();
    const events = [...builtInEvents(new Date(now.getTime() - 2 * 86400000), new Date(now.getTime() + 2 * 86400000)), ...this.feed];
    return newsDayPlan(events, now);
  }

  /** "Major US news day (CPI …)" when fibSweep should skip today, else null (late releases don't skip) */
  async majorNewsDay(now: Date = new Date()): Promise<string | null> {
    return (await this.dayPlan(now)).skip;
  }

  /** Events from 1 h ago to `hours` ahead (built-in + feed, de-duplicated), oldest first */
  async upcoming(hours: number = 48, now: Date = new Date()): Promise<NewsEvent[]> {
    await this.refresh();
    const from = new Date(now.getTime() - 3600000);
    const to = new Date(now.getTime() + hours * 3600000);
    const all = [...this.feed, ...builtInEvents(from, to)].filter((e) => e.at >= from && e.at <= to);
    const seen = new Set<string>();
    return all
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .filter((e) => {
        const key = `${e.at.getTime()}|${e.title.slice(0, 6).toLowerCase()}`;
        // the feed and the built-in list both have NFP / FOMC at the same minute
        const dupe = [...seen].some((k) => k.startsWith(`${e.at.getTime()}|`) && /payroll|fomc|federal|non-farm/i.test(e.title));
        if (seen.has(key) || dupe) return false;
        seen.add(key);
        return true;
      });
  }

  async check(utc: Date = new Date()): Promise<string | null> {
    await this.refresh();
    const events = [...builtInEvents(new Date(utc.getTime() - 86400000), new Date(utc.getTime() + 86400000)), ...this.feed];
    return newsBlackout(utc, events);
  }
}

export const newsCalendar = new NewsCalendar();
