import { config } from '../config';

export interface ZonedTime {
  hour: number;
  minute: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  /** YYYY-MM-DD in the target timezone */
  dateKey: string;
  /** Minutes since midnight */
  minutesOfDay: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Current wall-clock time in the bot's timezone (default Asia/Kolkata).
 * Works the same whether the server runs in UTC (EC2) or IST (your laptop).
 */
export function getZonedTime(date: Date = new Date(), timeZone: string = config.timezone): ZonedTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);

  return {
    hour,
    minute,
    weekday: WEEKDAYS.indexOf(get('weekday')),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: hour * 60 + minute,
  };
}

/**
 * Inside the London trading window (Mon–Fri)? The window is defined in
 * SESSION_TIMEZONE (Europe/London) so UK daylight-saving changes are automatic.
 */
export function isWithinTradingSession(
  date: Date = new Date(),
  start: number = config.sessionStart,
  end: number = config.sessionEnd,
  timeZone: string = config.sessionTimezone
): boolean {
  const t = getZonedTime(date, timeZone);
  if (t.weekday === 0 || t.weekday === 6) return false;
  return t.minutesOfDay >= start && t.minutesOfDay < end;
}

/** Weekend (Sat/Sun in the session timezone) — gold market closed */
export function isWeekend(date: Date = new Date(), timeZone: string = config.sessionTimezone): boolean {
  const day = getZonedTime(date, timeZone).weekday;
  return day === 0 || day === 6;
}

export function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Today's session window expressed in the display timezone (e.g. 13:30–17:00 IST).
 * Scans today's minutes in 5-minute steps — DST-safe without a tz library.
 */
export function sessionInDisplayZone(now: Date = new Date()): { opens: string; closes: string } | null {
  const local = getZonedTime(now);
  const dayStart = now.getTime() - (now.getTime() % 60000) - local.minutesOfDay * 60000;
  let opens: string | null = null;
  let closes: string | null = null;
  for (let m = 0; m <= 24 * 60; m += 5) {
    const d = new Date(dayStart + m * 60000);
    const lm = getZonedTime(d, config.sessionTimezone).minutesOfDay;
    const inside = lm >= config.sessionStart && lm < config.sessionEnd;
    if (inside && opens === null) opens = formatClock(getZonedTime(d));
    if (!inside && opens !== null) {
      closes = formatClock(getZonedTime(d));
      break;
    }
  }
  return opens && closes ? { opens, closes } : null;
}

export function formatClock(t: ZonedTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/** Inside the session of at least one portfolio strategy (STRATEGIES) */
export function isAnySleeveInSession(date: Date = new Date()): boolean {
  return config.sleeves.some((s) => isWithinTradingSession(date, s.sessionStart, s.sessionEnd));
}

/** A session-timezone (London) clock time expressed in the display timezone today, e.g. 08:00 London → "13:30" IST */
export function sessionClockInDisplayZone(minutes: number, now: Date = new Date()): string {
  const target = minutes % (24 * 60);
  const base = Math.floor(now.getTime() / 300000) * 300000; // 5-minute aligned so the scan hits HH:M0/M5
  for (let m = -12 * 60; m <= 36 * 60; m += 5) {
    const d = new Date(base + m * 60000);
    if (getZonedTime(d, config.sessionTimezone).minutesOfDay === target) return formatClock(getZonedTime(d));
  }
  return formatMinutes(minutes);
}

/**
 * MT5 broker server offset from UTC. FundedNext (like most MT5 brokers) runs on "New York close" time:
 * UTC+3 while New York is on daylight-saving time, UTC+2 otherwise. Bar times are server time written as UTC.
 */
export function brokerOffsetMs(serverTime: Date): number {
  const ny = getZonedTime(serverTime, 'America/New_York');
  let diff = serverTime.getUTCHours() * 60 + serverTime.getUTCMinutes() - ny.minutesOfDay;
  if (diff < 0) diff += 24 * 60;
  return (diff === 240 ? 3 : 2) * 3600000;
}

/** Real UTC instant of an MT5 bar/tick time (server time written as UTC) */
export function serverToUtc(serverTime: Date): Date {
  return new Date(serverTime.getTime() - brokerOffsetMs(serverTime));
}

/**
 * Server offset from a live tick when the tick is fresh (market open), else the NY-close rule.
 * On weekends the last tick is from Friday, so tick − now would give nonsense like −41 h.
 */
export function liveServerOffsetMs(tickTime: Date, now: Date = new Date()): number {
  const raw = Math.round((tickTime.getTime() - now.getTime()) / 1800000) * 1800000;
  const rule = brokerOffsetMs(new Date(now.getTime() + 2 * 3600000));
  return Math.abs(raw - rule) <= 3600000 ? raw : rule;
}
