import fs from 'fs';
import path from 'path';
import { config } from '../config';

// Create logs directory if it doesn't exist
const logsDir = config.logDir;
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

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

const logLevelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

class Logger {
  private currentLevel: LogLevel;
  private logFile: string;

  constructor(level: string = 'info') {
    this.currentLevel = levelMap[level.toLowerCase()] || LogLevel.INFO;
    this.logFile = path.join(logsDir, 'bot.log');
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString();
  }

  private writeLog(level: LogLevel, message: string, data?: any): void {
    if (level < this.currentLevel) return;

    const levelName = logLevelNames[level];
    const timestamp = this.formatTimestamp();
    const logMessage = `[${timestamp}] [${levelName}] ${message}`;

    // Console output with colors
    const colors: Record<LogLevel, string> = {
      [LogLevel.DEBUG]: '\x1b[36m', // Cyan
      [LogLevel.INFO]: '\x1b[32m', // Green
      [LogLevel.WARN]: '\x1b[33m', // Yellow
      [LogLevel.ERROR]: '\x1b[31m', // Red
    };

    const reset = '\x1b[0m';
    console.log(`${colors[level]}${logMessage}${reset}`, data || '');

    // File output
    try {
      const fileMessage = `${logMessage}${data ? ' ' + JSON.stringify(data) : ''}\n`;
      fs.appendFileSync(this.logFile, fileMessage, 'utf8');
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  debug(message: string, data?: any): void {
    this.writeLog(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: any): void {
    this.writeLog(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: any): void {
    this.writeLog(LogLevel.WARN, message, data);
  }

  error(message: string, data?: any): void {
    this.writeLog(LogLevel.ERROR, message, data);
  }
}

export const logger = new Logger(config.logLevel);
