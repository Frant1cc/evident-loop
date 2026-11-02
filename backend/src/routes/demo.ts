import { Router, type NextFunction, type Request, type Response } from 'express';

import { DemoAccessError, sessionTtlMs, type PublicDemoApplication } from '../modules/demo/index.js';
import { failure, success } from '../response.js';

type Visitor = { id: string; ip: string };
const visitors = new WeakMap<Request, Visitor>();
const opaque = '[0-9a-f-]{36}';
const allowed = [
  ['GET', /^\/demo$/],
  ['GET', /^\/research\/(tools|skills|conversations)$/],
  ['POST', /^\/research\/conversations$/],
  ['GET|DELETE', new RegExp(`^/research/conversations/${opaque}$`)],
  ['POST', new RegExp(`^/research/conversations/${opaque}/(messages|notes)$`)],
  ['PUT|DELETE', new RegExp(`^/research/notes/${opaque}$`)],
  ['GET', new RegExp(`^/research/runs/${opaque}/events$`)],
  ['POST', new RegExp(`^/research/runs/${opaque}/cancel$`)]
] as const;

export function demoVisitor(req: Request): Visitor {
  const visitor = visitors.get(req);
  if (!visitor) throw new DemoAccessError('体验会话已失效，请刷新页面。', 401);
  return visitor;
}

export function createDemoRouter(demo?: PublicDemoApplication) {
  const router = Router();
  if (!demo) {
    router.get('/demo', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(success({ enabled: false })); });
    return router;
  }
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    if (!allowed.some(([methods, path]) => methods.split('|').includes(req.method) && path.test(req.path))) {
      res.status(403).json(failure('公开试用暂未开放此功能。'));
      return;
    }
    if (req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json(failure('请从体验页面访问。'));
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && (req.get('x-requested-with') !== 'EvidentLoop' || !/^application\/json(?:\s*;|$)/i.test(req.get('content-type') ?? ''))) {
      res.status(403).json(failure('请从体验页面提交请求，公开试用暂不支持文件上传。'));
      return;
    }
    try {
      const name = demo.config.cookieSecure ? '__Host-evident_demo' : 'evident_demo';
      const matches = (req.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
      const token = matches.length === 1 ? matches[0]!.slice(name.length + 1) : undefined;
      const session = demo.openSession(token, req.ip ?? req.socket.remoteAddress ?? 'unknown');
      visitors.set(req, session);
      if (session.token) {
        res.cookie(name, session.token, { httpOnly: true, secure: demo.config.cookieSecure, sameSite: 'strict', path: '/', maxAge: sessionTtlMs });
      }
      if (req.method === 'GET' && req.path === '/demo') {
        res.json(success(demo.status(session.id)));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  return router;
}

export function demoErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (!(error instanceof DemoAccessError)) { next(error); return; }
  if (res.headersSent) { next(error); return; }
  if (error.status === 429) res.setHeader('Retry-After', String(error.retryAfter));
  res.status(error.status).json(failure(error.message));
}
