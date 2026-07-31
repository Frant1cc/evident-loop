import { Router } from 'express';

import { success } from '../response.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json(success({ ok: true, service: 'evident-loop-backend' }));
});
