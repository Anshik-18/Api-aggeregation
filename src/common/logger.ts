import pino, { LoggerOptions } from 'pino';
import { config } from '../config/index.js';

export const loggerConfig: LoggerOptions = {
  level: config.LOG_LEVEL,
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url,
        requestId: req.id,
        remoteAddress: req.ip,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
    err: pino.stdSerializers.err,
  },
  redact: {
    paths: ['req.headers["x-api-key"]', 'req.headers.authorization', 'req.headers.cookie'],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const rootLogger = pino(loggerConfig);
