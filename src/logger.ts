import winston from 'winston';
import util from 'util';
import { config } from './config';

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.metadata({ fillExcept: ['timestamp', 'level', 'message'] }),
    winston.format.printf((info) => {
      const { level, message, timestamp, metadata } = info as {
        level: string;
        message: string;
        timestamp: string;
        metadata?: unknown;
      };

      const isLocal = config.isLocal;

      let metaString = '';
      if (
        metadata &&
        (typeof metadata === 'object' ? Object.keys(metadata as object).length > 0 : true)
      ) {
        if (isLocal) {
          metaString = `\n${util.inspect(metadata, { colors: true, depth: null, breakLength: 80 })}`;
        } else {
          metaString = ` ${JSON.stringify(metadata)}`;
        }
      }

      const base = `${timestamp} [${level}] ${message}`;
      return isLocal
        ? winston.format.colorize().colorize(level, `${base}${metaString}`)
        : `${base}${metaString}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});
