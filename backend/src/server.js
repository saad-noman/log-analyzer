import app from './app.js';
import config from './config/config.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { checkHealth } from './services/modelService.js';
import { resumeInterrupted } from './services/analysisRunner.js';
import { applyDatabaseCacheCap } from './services/resourceMonitor.js';
import logger from './utils/logger.js';

async function start() {
  await connectDatabase();
  await applyDatabaseCacheCap(); // only if MONGO_WIREDTIGER_CACHE_MB is set

  // Bind the port BEFORE resuming jobs, so a failed start never leaves a job
  // half-run in a process that is about to exit. The API serves requests
  // (uploads, history) while the model is still loading.
  const server = await listen();
  logger.info(`API listening on http://${config.host}:${config.port}`);

  // `npm run dev` starts the model together with the API; wait until it has
  // loaded before resuming interrupted jobs, so they do not fail on startup.
  const model = await waitForModel();
  if (model.ok) {
    logger.info(`Local model ready (n_ctx ${model.serverContext})`);
    const resumed = await resumeInterrupted();
    if (resumed) logger.info(`Resumed ${resumed} interrupted analysis job(s)`);
  } else {
    logger.warn(`Local model not ready after ${config.ai.startupWaitMs / 1000}s: ${model.error} Interrupted jobs stay queued until the next start; use Retry once the model is running.`);
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down`);
    server.close();
    await disconnectDatabase().catch(() => {});
    process.exit(0);
  };
  // SIGHUP is sent on Windows when the terminal window is closed.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal));
}

// Polls the model's health until it is ready or the startup wait expires.
async function waitForModel() {
  const deadline = Date.now() + config.ai.startupWaitMs;
  let health = await checkHealth();
  while (!health.ok && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, config.ai.startupPollMs));
    health = await checkHealth();
  }
  return health;
}

// Resolves once the port is bound; turns listen errors into clear messages
// instead of an unhandled 'error' event crash.
function listen() {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host);
    server.once('listening', () => resolve(server));
    server.once('error', (err) => {
      const hints = {
        EADDRINUSE: `Port ${config.port} on ${config.host} is already in use. Another API instance is probably running: stop it, or set PORT in .env.`,
        EACCES: `No permission to listen on ${config.host}:${config.port}. Choose a port above 1024 with PORT in .env.`,
        EADDRNOTAVAIL: `Address ${config.host} is not available on this machine. Check HOST in .env.`,
      };
      reject(new Error(hints[err.code] || err.message));
    });
  });
}

// Last-resort logging: a stray rejection is reported, never silently lost.
process.on('unhandledRejection', (reason) => logger.error(`Unhandled rejection: ${reason?.stack || reason}`));

start().catch(async (err) => {
  logger.error(`Startup failed: ${err.message}`);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
