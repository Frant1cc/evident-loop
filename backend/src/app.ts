import cors from 'cors';
import express from 'express';

import { agentRouter } from './routes/agent.js';
import { artifactsRouter } from './routes/artifacts.js';
import { chatRouter } from './routes/chat.js';
import { dbTestRouter } from './routes/dbTest.js';
import { deepseekRouter } from './routes/deepseek.js';
import { evaluationsRouter } from './routes/evaluations.js';
import { healthRouter } from './routes/health.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { researchRouter } from './routes/research.js';
import { tasksRouter } from './routes/tasks.js';

export const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', healthRouter);
app.use('/api', knowledgeRouter);
app.use('/api', chatRouter);
app.use('/api', deepseekRouter);
app.use('/api', evaluationsRouter);
app.use('/api', agentRouter);
app.use('/api', artifactsRouter);
app.use('/api', researchRouter);
app.use('/api', tasksRouter);
app.use('/api', dbTestRouter);
