import { Router } from 'express';
import { getReport, downloadReport } from '../controllers/reportController.js';

const router = Router();

router.get('/:analysisId', getReport);
router.get('/:analysisId/download', downloadReport);

export default router;
