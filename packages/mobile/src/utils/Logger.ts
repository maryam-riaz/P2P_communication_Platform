/**
 * Logger.ts
 * 
 * Drop-in logger for BLE/WiFi Direct debugging
 * Works in both debug and release builds
 * 
 * Usage:
 * ```
 * import { logger } from './Logger';
 * logger.info('BLE', 'Scan started');
 * logger.error('WiFi', 'Connection failed', new Error('ECONNREFUSED'));
 * ```
 */

import { Alert } from 'react-native';

// Color codes for console output (if using a terminal that supports them)
const COLORS = {
  RESET: '\x1b[0m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  GREEN: '\x1b[32m',
  BLUE: '\x1b[34m',
  CYAN: '\x1b[36m',
  GRAY: '\x1b[90m',
};

interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  tag: string;
  message: string;
  error?: Error;
}

class Logger {
  private logs: LogEntry[] = [];
  private isDev = __DEV__;
  private maxLogs = 500; // Keep last 500 logs in memory
  private logCallbacks: Array<(entry: LogEntry) => void> = [];

  /**
   * Log info message
   */
  info(tag: string, message: string) {
    this._log('INFO', tag, message);
  }

  /**
   * Log warning message
   */
  warn(tag: string, message: string, error?: Error) {
    this._log('WARN', tag, message, error);
  }

  /**
   * Log error message
   */
  error(tag: string, message: string, error?: Error) {
    this._log('ERROR', tag, message, error);
  }

  /**
   * Log debug message (only in development)
   */
  debug(tag: string, message: string) {
    if (this.isDev) {
      this._log('DEBUG', tag, message);
    }
  }

  /**
   * Internal: handle all log calls
   */
  private _log(
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
    tag: string,
    message: string,
    error?: Error
  ) {
    const timestamp = new Date().toISOString();
    const entry: LogEntry = { timestamp, level, tag, message, error };

    // Add to in-memory buffer
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift(); // Remove oldest
    }

    // Format for console
    const emoji = this._getEmoji(level);
    const color = this._getColor(level);
    const formatted = `${color}${emoji} ${timestamp} [${level}] ${tag}: ${message}${COLORS.RESET}`;

    // Output to console
    switch (level) {
      case 'ERROR':
        console.error(formatted);
        if (error) console.error(error);
        break;
      case 'WARN':
        console.warn(formatted);
        if (error) console.warn(error);
        break;
      case 'DEBUG':
        console.debug(formatted);
        break;
      default:
        console.log(formatted);
    }

    // Notify subscribers (for in-app logging UI, Firebase, etc.)
    for (const callback of this.logCallbacks) {
      try {
        callback(entry);
      } catch (err) {
        console.error('[Logger] Callback error:', err);
      }
    }
  }

  /**
   * Subscribe to log entries (for in-app UI, Firebase, etc.)
   */
  subscribe(callback: (entry: LogEntry) => void): () => void {
    this.logCallbacks.push(callback);
    // Return unsubscribe function
    return () => {
      this.logCallbacks = this.logCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Get all logs as string (for saving to file or sharing)
   */
  getLogs(): string {
    return this.logs
      .map(
        entry =>
          `${entry.timestamp} [${entry.level}] ${entry.tag}: ${entry.message}${
            entry.error ? '\n' + entry.error.stack : ''
          }`
      )
      .join('\n');
  }

  /**
   * Get recent logs (last N entries)
   */
  getRecentLogs(count: number = 50): string {
    return this.logs
      .slice(-count)
      .map(
        entry =>
          `${entry.timestamp} [${entry.level}] ${entry.tag}: ${entry.message}${
            entry.error ? '\n' + entry.error.stack : ''
          }`
      )
      .join('\n');
  }

  /**
   * Clear all logs
   */
  clear() {
    this.logs = [];
  }

  /**
   * Show alert with recent logs (for debugging)
   */
  showAlert(title = 'Logs') {
    const recent = this.getRecentLogs(20);
    Alert.alert(title, recent.slice(0, 500)); // Truncate to fit in alert
  }

  /**
   * Get log statistics
   */
  getStats() {
    const counts = { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 };
    for (const log of this.logs) {
      counts[log.level]++;
    }
    return {
      total: this.logs.length,
      ...counts,
    };
  }

  /**
   * Get logs filtered by level or tag
   */
  filter(predicate: (entry: LogEntry) => boolean): string {
    return this.logs
      .filter(predicate)
      .map(
        entry =>
          `${entry.timestamp} [${entry.level}] ${entry.tag}: ${entry.message}${
            entry.error ? '\n' + entry.error.stack : ''
          }`
      )
      .join('\n');
  }

  /**
   * Get all errors
   */
  getErrors(): string {
    return this.filter(entry => entry.level === 'ERROR');
  }

  /**
   * Get logs by tag (e.g., all BLE logs)
   */
  getByTag(tag: string): string {
    return this.filter(entry => entry.tag.includes(tag));
  }

  // Helper: get emoji for log level
  private _getEmoji(level: string): string {
    switch (level) {
      case 'ERROR':
        return '❌';
      case 'WARN':
        return '⚠️ ';
      case 'INFO':
        return 'ℹ️ ';
      case 'DEBUG':
        return '🐛';
      default:
        return '📌';
    }
  }

  // Helper: get color for log level
  private _getColor(level: string): string {
    switch (level) {
      case 'ERROR':
        return COLORS.RED;
      case 'WARN':
        return COLORS.YELLOW;
      case 'INFO':
        return COLORS.GREEN;
      case 'DEBUG':
        return COLORS.CYAN;
      default:
        return COLORS.GRAY;
    }
  }
}

// Export singleton
export const logger = new Logger();
