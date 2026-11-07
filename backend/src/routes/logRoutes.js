import { Router } from 'express';
import { uploadLogFile, requireValidLog } from '../middleware/uploadMiddleware.js';
import { uploadLog, listLogs, getLog, deleteLog } from '../controllers/logController.js';

const router = Router();

router.post('/upload', uploadLogFile, requireValidLog, uploadLog);
router.get('/', listLogs);
router.get('/:id', getLog);
router.delete('/:id', deleteLog);

export default router;
