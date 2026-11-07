import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import config from './config/config.js';
import { isDatabaseConnected } from './config/database.js';
import { checkHealth } from './services/modelService.js';
import resourceMonitor from './services/resourceMonitor.js';
import logRoutes from './routes/logRoutes.js';
import analysisRoutes from './routes/analysisRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const app = express();

app.disable('x-powered-by');
// Basic hardening without extra dependencies: the API only serves JSON.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  next();
});
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '100kb' }));
if (config.env !== 'test') app.use(morgan('dev'));

// Reports whether the database and the local model are ready.
app.get('/api/health', async (req, res) => {
  const [model, resources] = await Promise.all([checkHealth(), resourceMonitor.snapshot()]);
  const database = isDatabaseConnected();
  // Upload limits are exposed so the UI can pre-validate files without duplicating config.
  const limits = { allowedExtensions: config.allowedExtensions, maxUploadBytes: config.maxUploadBytes };
  res.status(model.ok && database ? 200 : 503).json({ ok: model.ok && database, database, model, resources, limits });
});

app.use('/api/logs', logRoutes);
app.use('/api/analyses', analysisRoutes);
app.use('/api/reports', reportRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
