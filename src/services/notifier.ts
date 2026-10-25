import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export type NotifyLevel = 'info' | 'success' | 'warn' | 'error';

const ICON: Record<NotifyLevel, string> = { info: '🔵', success: '🟢', warn: '🟠', error: '🔴' };

export const escapeHtml = (s: unknown): string =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export interface Card {
  title: string;
  /** [label, value] rows; values are escaped */
  rows?: [string, string | number][];
  /** free text under the rows (escaped) */
  note?: string;
}

/**
 * Push alerts to Telegram (HTML) and/or Slack (plain text). Never throws — a failed alert must not
 * break trading. Repeated alerts with the same `key` are throttled.
 */
export class Notifier {
  private lastSent = new Map<string, number>();
  readonly sent: { level: NotifyLevel; text: string; at: string }[] = []; // recent history (tests / dashboard)

  get enabled(): boolean {
    return Boolean((config.telegramBotToken && config.telegramChatId) || config.slackWebhookUrl);
  }

  /** Plain message (kept for simple alerts) */
  async notify(level: NotifyLevel, text: string, key?: string, throttleMs: number = 10 * 60 * 1000): Promise<void> {
    const lines = text.split('\n');
    return this.card(level, { title: lines[0], note: lines.slice(1).join('\n') || undefined }, key, throttleMs);
  }

  /** Structured message: bold title, aligned rows, optional note */
  async card(level: NotifyLevel, card: Card, key?: string, throttleMs: number = 10 * 60 * 1000): Promise<void> {
    if (key) {
      const last = this.lastSent.get(key) ?? 0;
      if (Date.now() - last < throttleMs) return;
      this.lastSent.set(key, Date.now());
    }

    const plainRows = (card.rows ?? []).map(([k, v]) => `${k}: ${v}`);
    const plain = [card.title, ...plainRows, ...(card.note ? [card.note] : [])].join('\n');
    this.sent.push({ level, text: plain, at: new Date().toISOString() });
    if (this.sent.length > 50) this.sent.shift();

    const tag = config.dryRun ? 'PAPER' : 'LIVE';
    const html = [
      `${ICON[level]} <b>${escapeHtml(card.title)}</b>`,
      ...(card.rows?.length ? ['', ...card.rows.map(([k, v]) => `${escapeHtml(k)}: <b>${escapeHtml(v)}</b>`)] : []),
      ...(card.note ? ['', `<i>${escapeHtml(card.note)}</i>`] : []),
      '',
      `<code>FundedNext · XAUUSD · ${tag}</code>`,
    ].join('\n');

    const jobs: Promise<unknown>[] = [];
    if (config.telegramBotToken && config.telegramChatId) {
      jobs.push(
        axios.post(
          `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
          { chat_id: config.telegramChatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true },
          { timeout: 8000 }
        )
      );
    }
    if (config.slackWebhookUrl) {
      jobs.push(axios.post(config.slackWebhookUrl, { text: `${ICON[level]} ${plain}` }, { timeout: 8000 }));
    }

    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn('Notification failed', { error: (r.reason as Error)?.message });
      }
    }
  }

  /** Forget throttling for a key (e.g. after a recovery, so the next failure alerts immediately) */
  reset(key: string): void {
    this.lastSent.delete(key);
  }
}

export const notifier = new Notifier();
