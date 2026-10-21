import fs from 'fs';
import path from 'path';
import { config } from '../config';

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const levelMap: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[31m'];
const RESET = '\x1b[0m';
const MAX_LOG_BYTES = 10 * 1024 * 1024; // rotate bot.log at 10 MB

function serialize(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) {
    return JSON.stringify({ name: data.name, message: data.message, stack: data.stack });
  }
  try {
    return JSON.stringify(data, (_key, value) =>
      value instanceof Error ? { name: value.name, message: value.message } : value
    );
  } catch {
    return String(data);
  }
}

class Logger {
  private currentLevel: LogLevel;
  private logFile: string | null;

  constructor(level: string = 'info', logDir: string = './logs') {
    this.currentLevel = levelMap[level.toLowerCase()] ?? LogLevel.INFO;
    this.logFile = null;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.logFile = path.join(logDir, 'bot.log');
    } catch (err) {
      console.error('Logger: cannot create log directory, file logging disabled', err);
    }
  }

  private rotateIfNeeded(): void {
    if (!this.logFile) return;
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > MAX_LOG_BYTES) {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch {
      // rotation is best-effort
    }
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    if (level < this.currentLevel) return;

    const line = `[${new Date().toISOString()}] [${LEVEL_NAMES[level]}] ${message}`;
    const extra = serialize(data);
    const output = extra ? `${line} ${extra}` : line;

    if (level >= LogLevel.WARN) {
      console.error(`${COLORS[level]}${output}${RESET}`);
    } else {
      console.log(`${COLORS[level]}${output}${RESET}`);
    }

    if (!this.logFile) return;
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.logFile, `${output}\n`, 'utf8');
    } catch {
      // never crash the bot because of logging
    }
  }

  debug(message: string, data?: unknown): void {
    this.write(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: unknown): void {
    this.write(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write(LogLevel.WARN, message, data);
  }

  error(message: string, data?: unknown): void {
    this.write(LogLevel.ERROR, message, data);
  }
}

export const logger = new Logger(config.debug ? 'debug' : config.logLevel, config.logDir);
