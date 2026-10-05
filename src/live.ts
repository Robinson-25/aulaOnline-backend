// Avisos en vivo: el backend notifica a las páginas abiertas cuando algo cambia,
// para que se actualicen solas sin recargar. Usa Server-Sent Events (una conexión
// que queda abierta y por la que el servidor envía mensajes cortos).
import type { Request, Response, NextFunction } from 'express';

const clients = new Set<Response>();

/** GET /api/events — cada página abierta se suscribe aquí. */
export function events(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // evita que un proxy retenga los mensajes
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
// Latido cada 25 s para que la conexión no se cierre por inactividad.
setInterval(() => { for (const c of clients) c.write(': ok\n\n'); }, 25000).unref();

/**
 * scope "contenido": cambió algo desde el panel (cursos, lecciones, compras aprobadas…).
 * scope "actividad": un estudiante hizo algo (compra, pregunta, reseña…); solo le interesa al panel.
 * El aviso no lleva datos: cada página vuelve a pedir lo suyo y el backend aplica los permisos de siempre.
 */
export function broadcast(scope: 'contenido' | 'actividad'): void {
  const msg = `data: ${JSON.stringify({ scope, t: Date.now() })}\n\n`;
  for (const c of clients) c.write(msg);
}

/** Tras cada operación que modifica datos y termina bien, avisa a las páginas abiertas. */
export function notifyChanges(req: Request, res: Response, next: NextFunction): void {
  const p = req.path;
  if (req.method !== 'GET' && !p.startsWith('/auth') && !p.startsWith('/admin/upload'))
    res.on('finish', () => { if (res.statusCode < 400) broadcast(p.startsWith('/admin') ? 'contenido' : 'actividad'); });
  next();
}
