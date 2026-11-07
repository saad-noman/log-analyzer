import { Router } from 'express';
import { createAnalysis, listAnalyses, getAnalysis, retry, cancel, listChunkFindings, deleteAnalysis } from '../controllers/analysisController.js';

const router = Router();

router.post('/', createAnalysis);
router.get('/', listAnalyses);
router.get('/:id', getAnalysis);
router.post('/:id/retry', retry);
router.post('/:id/cancel', cancel);
router.get('/:id/findings', listChunkFindings);
router.delete('/:id', deleteAnalysis);

export default router;
