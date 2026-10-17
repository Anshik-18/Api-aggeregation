import { buildApp } from './app.js';
import { config } from './config/index.js';
import { rootLogger } from './common/logger.js';
import { Database } from './database/index.js';
import { RedisClient } from './database/redis.js';

async function startServer() {
  const app = buildApp();

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    rootLogger.info(`Received ${signal}. Gracefully shutting down...`);
    try {
      await app.close();
      await Database.close();
      await RedisClient.close();
      rootLogger.info('Server shutdown completed cleanly');
      process.exit(0);
    } catch (err) {
      rootLogger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    const address = await app.listen({
      port: config.PORT,
      host: config.HOST,
    });
    rootLogger.info(`Gateway server listening at ${address}`);
  } catch (err) {
    rootLogger.fatal({ err }, 'Failed to start gateway server');
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}
