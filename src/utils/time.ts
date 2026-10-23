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
