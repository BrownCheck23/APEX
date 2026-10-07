import winston from 'winston';
import fs from 'node:fs';
import path from 'node:path';
import { config, redact } from './config/index.js';

fs.mkdirSync(config.logDir, { recursive: true });

// Rule 5: never let API keys reach logs. Every message passes through redact().
const scrub = winston.format((info) => {
  info.message = redact(String(info.message));
  const rest = (info as Record<symbol, unknown>)[Symbol.for('splat')];
  if (Array.isArray(rest)) {
    (info as Record<symbol, unknown>)[Symbol.for('splat')] = rest.map((r) =>
      typeof r === 'string' ? redact(r) : r instanceof Error ? redact(r.stack ?? r.message) : r,
    );
  }
  return info;
});

const line = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const splat = (meta as Record<symbol, unknown>)[Symbol.for('splat')];
  const extra = Array.isArray(splat) && splat.length
    ? ' ' + redact(splat.map((s) => (typeof s === 'string' ? s : s instanceof Error ? s.stack ?? s.message : JSON.stringify(s))).join(' '))
    : '';
  return `${timestamp} [${level}] ${message}${extra}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(scrub(), winston.format.timestamp(), line),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(config.logDir, 'apex.log'), maxsize: 5_000_000, maxFiles: 5 }),
  ],
});
