import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export type NotifyLevel = 'info' | 'success' | 'warn' | 'error';

const ICON: Record<NotifyLevel, string> = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '🚨' };

/**
 * Push alerts to Telegram and/or Slack. Never throws — a failed alert must not
 * break trading. Repeated alerts with the same `key` are throttled.
 */
export class Notifier {
  private lastSent = new Map<string, number>();
  readonly sent: { level: NotifyLevel; text: string }[] = []; // recent history (tests / dashboard)

  get enabled(): boolean {
    return Boolean((config.telegramBotToken && config.telegramChatId) || config.slackWebhookUrl);
  }

  /**
   * @param key       throttle key (same key within `throttleMs` is dropped)
   * @param throttleMs default 10 minutes for keyed alerts
   */
  async notify(level: NotifyLevel, text: string, key?: string, throttleMs: number = 10 * 60 * 1000): Promise<void> {
    if (key) {
      const last = this.lastSent.get(key) ?? 0;
      if (Date.now() - last < throttleMs) return;
      this.lastSent.set(key, Date.now());
    }

    const message = `${ICON[level]} FundedNext Bot\n${text}`;
    this.sent.push({ level, text });
    if (this.sent.length > 50) this.sent.shift();

    const jobs: Promise<unknown>[] = [];
    if (config.telegramBotToken && config.telegramChatId) {
      jobs.push(
        axios.post(
          `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
          { chat_id: config.telegramChatId, text: message, disable_web_page_preview: true },
          { timeout: 8000 }
        )
      );
    }
    if (config.slackWebhookUrl) {
      jobs.push(axios.post(config.slackWebhookUrl, { text: message }, { timeout: 8000 }));
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
