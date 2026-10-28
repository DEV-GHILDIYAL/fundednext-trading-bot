/**
 * Dashboard trading switch, saved to data/control.json so it survives restarts and deploys.
 *
 *   ON  → the bot opens new trades every day as the strategy says (default)
 *   OFF → no new trades at all; open trades keep their SL/TP and are still monitored
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ControlState {
  tradingEnabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export class Control {
  private state: ControlState = { tradingEnabled: true, updatedAt: null, updatedBy: null };
  private readonly file: string | null;

  /** @param dataDir null = memory only (tests) */
  constructor(dataDir: string | null = config.dataDir) {
    this.file = dataDir ? path.join(dataDir, 'control.json') : null;
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file)) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ControlState>;
        this.state = {
          tradingEnabled: saved.tradingEnabled !== false,
          updatedAt: saved.updatedAt ?? null,
          updatedBy: saved.updatedBy ?? null,
        };
      }
    } catch (error) {
      logger.warn('Could not read control.json — trading stays ON', error);
    }
  }

  get snapshot(): ControlState {
    return { ...this.state };
  }

  get tradingEnabled(): boolean {
    return this.state.tradingEnabled;
  }

  setTrading(enabled: boolean, by: string): ControlState {
    this.state = { tradingEnabled: enabled, updatedAt: new Date().toISOString(), updatedBy: by };
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
        fs.renameSync(tmp, this.file);
      } catch (error) {
        logger.error('Could not save control.json', error);
      }
    }
    return this.snapshot;
  }
}

export const control = new Control();
