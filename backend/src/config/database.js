import mongoose from 'mongoose';
import config from './config.js';
import logger from '../utils/logger.js';

export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  logger.info(`MongoDB connected: ${mongoose.connection.name}`);
}

export const isDatabaseConnected = () => mongoose.connection.readyState === 1;

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
