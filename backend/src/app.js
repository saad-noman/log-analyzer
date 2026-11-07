import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import config from './config/config.js';
import { isDatabaseConnected } from './config/database.js';
import { checkHealth } from './services/modelService.js';
import logRoutes from './routes/logRoutes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const app = express();

app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '100kb' }));
if (config.env !== 'test') app.use(morgan('dev'));

// Reports whether the database and the local model are ready.
app.get('/api/health', async (req, res) => {
  const model = await checkHealth();
  const database = isDatabaseConnected();
  res.status(model.ok && database ? 200 : 503).json({ ok: model.ok && database, database, model });
});

app.use('/api/logs', logRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
