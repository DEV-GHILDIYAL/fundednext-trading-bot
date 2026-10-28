/**
 * Dashboard login: a signed session cookie instead of the browser's Basic-auth popup.
 *
 *   token = "<expiry ms>.<HMAC-SHA256(expiry, key)>", key derived from DASHBOARD_USER + DASHBOARD_PASSWORD
 *   → survives bot restarts, and every session is logged out when the password changes.
 *
 * Basic auth is still accepted for scripts (preflight's curl -u), but the server never asks for it,
 * so browsers never show the popup.
 */
import http from 'http';
import crypto from 'crypto';
import { config } from '../config';

export const SESSION_COOKIE = 'fnb_session';
export const SESSION_DAYS = 7;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60000;

export function authEnabled(): boolean {
  return Boolean(config.dashboardUser && config.dashboardPassword);
}

function key(): Buffer {
  return crypto.createHash('sha256').update(`fnb-session|${config.dashboardUser}|${config.dashboardPassword}`).digest();
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function makeSessionToken(now: number = Date.now()): string {
  const exp = String(now + SESSION_DAYS * 86400000);
  return `${exp}.${sign(exp)}`;
}

export function verifySessionToken(token: string | undefined, now: number = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < now) return false;
  return safeEqual(token.slice(dot + 1), sign(exp));
}

export function checkCredentials(user: unknown, password: unknown): boolean {
  if (typeof user !== 'string' || typeof password !== 'string') return false;
  // evaluate both, so timing does not reveal which one was wrong
  const u = safeEqual(user, config.dashboardUser);
  const p = safeEqual(password, config.dashboardPassword);
  return u && p;
}

export function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function basicOk(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  return sep >= 0 && checkCredentials(decoded.slice(0, sep), decoded.slice(sep + 1));
}

export function isAuthorized(req: http.IncomingMessage): boolean {
  if (!authEnabled()) return true;
  return verifySessionToken(parseCookies(req)[SESSION_COOKIE]) || basicOk(req);
}

function secureFlag(req: http.IncomingMessage): string {
  return req.headers['x-forwarded-proto'] === 'https' || (req.socket as { encrypted?: boolean }).encrypted ? '; Secure' : '';
}

export function sessionCookie(req: http.IncomingMessage, token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secureFlag(req)}`;
}

export function clearCookie(req: http.IncomingMessage): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag(req)}`;
}

/** Brute-force guard: 5 wrong logins from one address → locked for 15 min */
const failures = new Map<string, { count: number; until: number }>();

export function clientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

export function lockedFor(ip: string, now: number = Date.now()): number {
  const f = failures.get(ip);
  return f && f.until > now ? f.until - now : 0;
}

export function recordLogin(ip: string, ok: boolean, now: number = Date.now()): void {
  if (ok) {
    failures.delete(ip);
    return;
  }
  const f = failures.get(ip);
  const count = f && f.until <= now && f.count >= LOCK_AFTER ? 1 : (f?.count ?? 0) + 1;
  failures.set(ip, { count, until: count >= LOCK_AFTER ? now + LOCK_MS : 0 });
}

export function resetLoginGuard(): void {
  failures.clear();
}
