import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { q } from './db.ts';

export interface User { id: number; name: string; email: string; password_hash: string; role: 'estudiante' | 'admin'; phone: string | null }
declare global { namespace Express { interface Request { user?: User | null } } }

export const SECRET = process.env.JWT_SECRET || 'solo-desarrollo-cambia-esta-clave';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || /cambia/.test(process.env.JWT_SECRET))) {
  console.error('Configura JWT_SECRET en el archivo .env antes de publicar el sitio.'); process.exit(1);
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };
export const signUser = (u: { id: number }) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' });
export const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || '' });

export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (m) try { req.user = (q.get('SELECT * FROM users WHERE id=?', (jwt.verify(m[1], SECRET) as { id: number }).id) as User) || null; } catch { /* token inválido */ }
  next();
}
export const requireAuth = (req: Request, _res: Response, next: NextFunction) => (req.user ? next() : next(new HttpError(401, 'Inicia sesión para continuar.')));
export const requireAdmin = (req: Request, _res: Response, next: NextFunction) =>
  !req.user ? next(new HttpError(401, 'Inicia sesión para continuar.')) : req.user.role !== 'admin' ? next(new HttpError(403, 'No tienes permiso para esta sección.')) : next();

// Enlaces firmados y temporales para archivos privados (videos, comprobantes).
export const signMedia = (file: string | null | undefined): string | null => (file ? `/api/media?f=${encodeURIComponent(jwt.sign({ f: file }, SECRET, { expiresIn: '12h' }))}` : null);
export const readMedia = (token: string): string | null => { try { return (jwt.verify(token, SECRET) as { f: string }).f; } catch { return null; } };

// Límite simple de intentos (protege ingreso y recuperación de contraseña).
const hits = new Map<string, number[]>();
export const limit = (max: number, minutes: number) => (req: Request, _res: Response, next: NextFunction) => {
  const key = req.ip + req.path, now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < minutes * 60000);
  list.push(now); hits.set(key, list);
  list.length > max ? next(new HttpError(429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.')) : next();
};
