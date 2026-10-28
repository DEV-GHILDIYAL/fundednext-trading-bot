import http from 'http';
import { AddressInfo } from 'net';
import { config } from '../../src/config';
import { handleRequest } from '../../src/server/dashboardServer';
import { makeSessionToken, verifySessionToken, resetLoginGuard, SESSION_DAYS } from '../../src/server/auth';
import { validateLevels, validateManualOrder } from '../../src/server/actions';
import { control, Control } from '../../src/services/control';

const cfg = config as unknown as { dashboardUser: string; dashboardPassword: string };

describe('session token', () => {
  beforeAll(() => {
    cfg.dashboardUser = 'dev';
    cfg.dashboardPassword = 's3cret';
  });
  it('valid until expiry, rejects tampering and old passwords', () => {
    const t = makeSessionToken(1_000);
    expect(verifySessionToken(t, 2_000)).toBe(true);
    expect(verifySessionToken(t, 1_000 + SESSION_DAYS * 86400000 + 1)).toBe(false);
    expect(verifySessionToken(t.replace(/^\d+/, '9999999999999'), 2_000)).toBe(false);
    expect(verifySessionToken('garbage', 2_000)).toBe(false);
    cfg.dashboardPassword = 'changed';
    expect(verifySessionToken(t, 2_000)).toBe(false); // password change logs everyone out
    cfg.dashboardPassword = 's3cret';
  });
});

describe('validateLevels', () => {
  it('BUY: SL below bid, TP above ask', () => {
    expect(validateLevels('BUY', 3990, 4030, 4000, 4000.4)).toBeNull();
    expect(validateLevels('BUY', 4001, 4030, 4000, 4000.4)).toMatch(/below/);
    expect(validateLevels('BUY', 3990, 3999, 4000, 4000.4)).toMatch(/above/);
  });
  it('SELL: SL above ask, TP below bid; fat-finger guard', () => {
    expect(validateLevels('SELL', 4010, 3970, 4000, 4000.4)).toBeNull();
    expect(validateLevels('SELL', 4000.2, 3970, 4000, 4000.4)).toMatch(/above/);
    expect(validateLevels('SELL', 40100, 3970, 4000, 4000.4)).toMatch(/typo/);
    expect(validateLevels('SELL', NaN, 3970, 4000, 4000.4)).toMatch(/positive/);
  });
});

describe('validateManualOrder', () => {
  const q = { bid: 4000, ask: 4000.4 };
  const room = { daily: 300, total: 600 };
  it('accepts a sane order', () => {
    expect(validateManualOrder({ side: 'BUY', lots: 0.05, sl: 3990, tp: 4020 }, q, [], room)).toBeNull();
  });
  it('rejects bad side, lots, levels', () => {
    expect(validateManualOrder({ side: 'HOLD', lots: 0.05, sl: 3990, tp: 4020 }, q, [], room)).toMatch(/side/);
    expect(validateManualOrder({ side: 'BUY', lots: 0, sl: 3990, tp: 4020 }, q, [], room)).toMatch(/Lots/);
    expect(validateManualOrder({ side: 'BUY', lots: 5, sl: 3990, tp: 4020 }, q, [], room)).toMatch(/Lots/);
    expect(validateManualOrder({ side: 'BUY', lots: 0.055, sl: 3990, tp: 4020 }, q, [], room)).toMatch(/steps/);
    expect(validateManualOrder({ side: 'SELL', lots: 0.05, sl: 3990, tp: 4020 }, q, [], room)).toMatch(/SELL/);
  });
  it('no hedging against any open position (bot or manual)', () => {
    expect(validateManualOrder({ side: 'BUY', lots: 0.05, sl: 3990, tp: 4020 }, q, ['SELL'], room)).toMatch(/hedging/);
    expect(validateManualOrder({ side: 'BUY', lots: 0.05, sl: 3990, tp: 4020 }, q, ['BUY'], room)).toBeNull();
  });
  it('blocks a risk that would break the loss limits', () => {
    // 0.5 lot × $10.40 × 100 = $520 > $300 room today
    expect(validateManualOrder({ side: 'BUY', lots: 0.5, sl: 3990, tp: 4020 }, q, [], room)).toMatch(/loss limit/);
  });
});

describe('control state', () => {
  it('defaults ON and can be switched', () => {
    const c = new Control(null);
    expect(c.tradingEnabled).toBe(true);
    c.setTrading(false, 'test');
    expect(c.snapshot).toMatchObject({ tradingEnabled: false, updatedBy: 'test' });
  });
});

describe('dashboard HTTP: login page instead of popup', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    cfg.dashboardUser = 'dev';
    cfg.dashboardPassword = 's3cret';
    server = http.createServer(handleRequest);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    control.setTrading(true, 'test');
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => resetLoginGuard());

  const login = (user: string, password: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FNB': '1', ...headers }, body: JSON.stringify({ user, password }) });

  it('no Basic-auth popup: / redirects to /login, API answers 401 JSON', async () => {
    const r = await fetch(`${base}/`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/login');
    expect(r.headers.get('www-authenticate')).toBeNull();
    const api = await fetch(`${base}/api/status`);
    expect(api.status).toBe(401);
    expect(api.headers.get('www-authenticate')).toBeNull();
    const page = await fetch(`${base}/login`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Sign in/);
  });

  it('wrong password → 401, right one → HttpOnly session cookie that opens the dashboard', async () => {
    expect((await login('dev', 'nope')).status).toBe(401);
    const ok = await login('dev', 's3cret');
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/fnb_session=\d+\./);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const page = await fetch(`${base}/`, { headers: { cookie: cookie.split(';')[0] } });
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Auto trading/);
  });

  it('locks an address after 5 wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await login('dev', 'bad');
    const r = await login('dev', 's3cret');
    expect(r.status).toBe(429);
  });

  it('trading switch: needs login + our header, persists the state', async () => {
    const cookie = ((await login('dev', 's3cret')).headers.get('set-cookie') ?? '').split(';')[0];
    const body = JSON.stringify({ tradingEnabled: false });
    expect((await fetch(`${base}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FNB': '1' }, body })).status).toBe(401);
    expect((await fetch(`${base}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body })).status).toBe(403);
    expect((await fetch(`${base}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FNB': '1', cookie, origin: 'http://evil.example' }, body })).status).toBe(403);
    const r = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FNB': '1', cookie }, body });
    expect(r.status).toBe(200);
    expect(control.tradingEnabled).toBe(false);
    const bad = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FNB': '1', cookie }, body: JSON.stringify({ tradingEnabled: 'yes' }) });
    expect(bad.status).toBe(400);
  });

  it('scripts can still use Basic auth (preflight curl -u)', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const auth = 'Basic ' + Buffer.from('dev:s3cret').toString('base64');
    const page = await fetch(`${base}/`, { headers: { authorization: auth }, redirect: 'manual' });
    expect(page.status).toBe(200);
  });
});
