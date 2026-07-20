export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
export type FeatureTag = 'BLE' | 'TCP' | 'DB' | 'CHAT' | 'UI' | 'P2P' | 'SEC' | 'AUTH' | 'MAP' | 'SOS' | 'SYS';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const ANSI = {
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
  GRAY: '\x1b[90m',
  GREEN: '\x1b[32m',
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  ERROR: ANSI.RED,
  WARN: ANSI.YELLOW,
  INFO: ANSI.CYAN,
  DEBUG: ANSI.GRAY,
};

const LEVEL_CONSOLE_METHOD: Record<LogLevel, 'error' | 'warn' | 'info' | 'debug'> = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
};

let currentLevel: LogLevel = __DEV__ ? 'DEBUG' : 'WARN';
let fileLoggingEnabled = false;
let fileLogBuffer: string[] = [];
const FILE_BUFFER_FLUSH_SIZE = 50;
let fileFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
  logger.sys.info(`Log level changed to ${level}`);
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function enableFileLogging(enabled: boolean): void {
  fileLoggingEnabled = enabled;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[currentLevel];
}

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString();
}

function sanitizeForLog(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    if (data.length > 500) return data.substring(0, 500) + '...[truncated]';
    return data;
  }
  if (typeof data === 'object') {
    try {
      const str = JSON.stringify(data);
      if (str && str.length > 1000) return str.substring(0, 1000) + '...[truncated]';
      return data;
    } catch {
      return '[Unserializable object]';
    }
  }
  return data;
}

function formatLogLine(
  level: LogLevel,
  feature: FeatureTag,
  thread: string,
  message: string,
  data?: any
): string {
  const ts = formatTimestamp();
  const color = LEVEL_COLOR[level];
  const tag = `[${feature}]`;
  const threadTag = `(${thread})`;
  const levelTag = level.padEnd(5);

  const colorPrefix = `${ANSI.GRAY}${ts}${ANSI.RESET} ${color}${ANSI.BOLD}${levelTag}${ANSI.RESET} ${ANSI.GREEN}${tag}${ANSI.RESET} ${threadTag}`;

  let line = `${colorPrefix} ${message}`;
  if (data !== undefined) {
    const sanitized = sanitizeForLog(data);
    const dataStr = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
    line += ` | ${dataStr}`;
  }

  return line;
}

function formatStructuredEntry(
  level: LogLevel,
  feature: FeatureTag,
  thread: string,
  message: string,
  data?: any
): string {
  const entry = {
    ts: formatTimestamp(),
    level,
    feature,
    thread,
    msg: message,
    ...(data !== undefined ? { data: sanitizeForLog(data) } : {}),
  };
  return JSON.stringify(entry);
}

async function flushFileBuffer(): Promise<void> {
  if (fileLogBuffer.length === 0) return;

  const lines = fileLogBuffer.splice(0);
  const content = lines.join('\n') + '\n';

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FileSystem = require('expo-file-system');
    const logDir = `${FileSystem.documentDirectory}logs`;

    const dirInfo = await FileSystem.getInfoAsync(logDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(logDir, { intermediates: true });
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const logFile = `${logDir}/app-${dateStr}.log`;

    await FileSystem.writeAsStringAsync(logFile, content, {
      encoding: 'utf8',
    } as any);
  } catch (err) {
    console.debug('[Logger] File write failed:', err);
  }
}

function scheduleFileFlush(): void {
  if (fileFlushTimer) return;
  fileFlushTimer = setTimeout(() => {
    fileFlushTimer = null;
    flushFileBuffer();
  }, 2000);
}

function emit(
  level: LogLevel,
  feature: FeatureTag,
  thread: string,
  message: string,
  data?: any
): void {
  if (!shouldLog(level)) return;

  const line = formatLogLine(level, feature, thread, message, data);
  const method = LEVEL_CONSOLE_METHOD[level];
  console[method](line);

  if (fileLoggingEnabled) {
    const structured = formatStructuredEntry(level, feature, thread, message, data);
    fileLogBuffer.push(structured);
    if (fileLogBuffer.length >= FILE_BUFFER_FLUSH_SIZE) {
      flushFileBuffer();
    } else {
      scheduleFileFlush();
    }
  }
}

interface FeatureLogger {
  error(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  info(message: string, data?: any): void;
  debug(message: string, data?: any): void;
}

function createFeatureLogger(feature: FeatureTag, defaultThread?: string): FeatureLogger {
  const thread = defaultThread || 'js-main';
  return {
    error(message: string, data?: any) {
      emit('ERROR', feature, thread, message, data);
    },
    warn(message: string, data?: any) {
      emit('WARN', feature, thread, message, data);
    },
    info(message: string, data?: any) {
      emit('INFO', feature, thread, message, data);
    },
    debug(message: string, data?: any) {
      emit('DEBUG', feature, thread, message, data);
    },
  };
}

export const logger = {
  ble: createFeatureLogger('BLE', 'js-ble'),
  tcp: createFeatureLogger('TCP', 'js-tcp'),
  db: createFeatureLogger('DB', 'js-db'),
  chat: createFeatureLogger('CHAT', 'js-chat'),
  ui: createFeatureLogger('UI', 'js-ui'),
  p2p: createFeatureLogger('P2P', 'js-p2p'),
  sec: createFeatureLogger('SEC', 'js-sec'),
  auth: createFeatureLogger('AUTH', 'js-auth'),
  map: createFeatureLogger('MAP', 'js-map'),
  sos: createFeatureLogger('SOS', 'js-sos'),
  sys: createFeatureLogger('SYS', 'js-sys'),

  emit,

  withThread(feature: FeatureTag, thread: string): FeatureLogger {
    return createFeatureLogger(feature, thread);
  },

  async getLogFilePath(): Promise<string | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const FileSystem = require('expo-file-system');
      const dateStr = new Date().toISOString().split('T')[0];
      return `${FileSystem.documentDirectory}logs/app-${dateStr}.log`;
    } catch {
      return null;
    }
  },

  async exportLogs(): Promise<string | null> {
    try {
      await flushFileBuffer();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const FileSystem = require('expo-file-system');
      const dateStr = new Date().toISOString().split('T')[0];
      const logFile = `${FileSystem.documentDirectory}logs/app-${dateStr}.log`;
      const info = await FileSystem.getInfoAsync(logFile);
      if (info.exists) {
        return logFile;
      }
      return null;
    } catch {
      return null;
    }
  },
};

export default logger;
