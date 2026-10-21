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

export function isWithinTradingSession(date: Date = new Date()): boolean {
  const t = getZonedTime(date);
  if (t.weekday === 0 || t.weekday === 6) return false;

  const open = config.londonOpenHour * 60 + config.londonOpenMinute;
  const close = config.londonCloseHour * 60 + config.londonCloseMinute;
  return t.minutesOfDay >= open && t.minutesOfDay < close;
}

export function formatClock(t: ZonedTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}
