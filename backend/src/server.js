import app from './app.js';
import config from './config/config.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { checkHealth } from './services/modelService.js';
import logger from './utils/logger.js';

async function start() {
  await connectDatabase();

  // The API can start without the model (uploads still work); analysis
  // reports a clear error until `npm run model` is running.
  const model = await checkHealth();
  if (model.ok) logger.info(`Local model ready (n_ctx ${model.serverContext})`);
  else logger.warn(`Local model not ready: ${model.error}`);

  const server = app.listen(config.port, () => logger.info(`API listening on http://localhost:${config.port}`));

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  logger.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
