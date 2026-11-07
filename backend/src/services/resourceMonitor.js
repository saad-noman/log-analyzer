// resource_monitor: measures the real memory of the whole stack against the
// 4 GB limit - the Node backend, the llama.cpp model server and MongoDB.
//
//  - Node:     process.memoryUsage().rss
//  - MongoDB:  serverStatus().mem.resident (no OS access needed)
//  - Model:    resident memory of the model process, read from the OS process
//              list with a FIXED command (tasklist / ps) via execFile - no
//              shell, no user or log input in the arguments.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import config from '../config/config.js';
import logger from '../utils/logger.js';

const run = promisify(execFile);
const rcfg = config.resources;
const MB = 1024 * 1024;

// Resident memory (MB) of all processes named like the model server.
async function modelProcessMb() {
  const name = rcfg.modelProcessName;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true });
      // "llama-server.exe","8096","Console","23","1,808,476 K"
      const kb = [...stdout.matchAll(/"([\d.,\s]+) K"/g)].reduce((s, m) => s + Number(m[1].replace(/\D/g, '')), 0);
      return kb ? Math.round(kb / 1024) : null;
    }
    const { stdout } = await run('ps', ['-A', '-o', 'rss=,comm='], { timeout: 5000 });
    const kb = stdout
      .split('\n')
      .filter((l) => l.trim().endsWith(name))
      .reduce((s, l) => s + Number(l.trim().split(/\s+/)[0] || 0), 0);
    return kb ? Math.round(kb / 1024) : null;
  } catch {
    return null;
  }
}

async function databaseMb() {
  try {
    if (mongoose.connection.readyState !== 1) return null;
    const status = await mongoose.connection.db.admin().command({ serverStatus: 1 });
    return status.mem?.resident ?? null; // already in MB
  } catch {
    return null;
  }
}

/** Current memory of the stack. Unknown parts are null (not counted as 0 silently). */
export async function snapshot() {
  const [modelMb, dbMb] = await Promise.all([modelProcessMb(), databaseMb()]);
  const nodeMb = Math.round(process.memoryUsage().rss / MB);
  const known = [nodeMb, modelMb, dbMb].filter((v) => v !== null);
  const totalMb = known.reduce((s, v) => s + v, 0);
  return {
    nodeMb,
    modelMb,
    databaseMb: dbMb,
    totalMb,
    complete: known.length === 3, // false if a component could not be measured
    limitMb: rcfg.memoryLimitMb,
    withinLimit: totalMb <= rcfg.memoryLimitMb,
    nearLimit: totalMb >= rcfg.memoryLimitMb * rcfg.warnRatio,
    system: { totalMb: Math.round(os.totalmem() / MB), freeMb: Math.round(os.freemem() / MB) },
  };
}

/** Samples memory, logs a warning near the limit and returns the sample. */
export async function check(label = '') {
  const s = await snapshot();
  if (!s.withinLimit || s.nearLimit) {
    logger.warn(`Memory ${label}: ${s.totalMb} MB of ${s.limitMb} MB (node ${s.nodeMb}, model ${s.modelMb}, db ${s.databaseMb})`);
  }
  return s;
}

/** Optional: cap MongoDB's cache at runtime (MONGO_WIREDTIGER_CACHE_MB). */
export async function applyDatabaseCacheCap() {
  if (!rcfg.mongoCacheMb) return false;
  try {
    await mongoose.connection.db.admin().command({ setParameter: 1, wiredTigerEngineRuntimeConfig: `cache_size=${rcfg.mongoCacheMb}M` });
    logger.info(`MongoDB WiredTiger cache capped at ${rcfg.mongoCacheMb} MB`);
    return true;
  } catch (err) {
    logger.warn(`Could not cap MongoDB cache: ${err.message}`);
    return false;
  }
}

export default { snapshot, check, applyDatabaseCacheCap };
