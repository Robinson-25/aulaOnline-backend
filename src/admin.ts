// Panel de administración: todas las rutas exigen una cuenta con rol "admin".
import { Router, type Request } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { q, slugify, UPLOAD_DIR, type Row } from './db.ts';
import { HttpError, fail, requireAdmin, signMedia } from './auth.ts';
import { courseProgress } from './cert.ts';
import { approveOrder, courseOut } from './app.ts';
import { sendMail } from './mail.ts';

const r = Router();
r.use(requireAdmin);
const str = (v: unknown, max = 20000): string => String(v ?? '').trim().slice(0, max);
const lines = (v: unknown): string => JSON.stringify((Array.isArray(v) ? v : String(v || '').split('\n')).map((s) => String(s).trim()).filter(Boolean).slice(0, 30));
const num = (v: unknown, d = 0): number => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const id = (req: Request): number => Number(req.params.id);

r.get('/summary', (_req, res) => {
  const n = (sql: string): number => q.get(sql)!.n;
  res.json({
    courses: n('SELECT COUNT(*) n FROM courses'), published: n('SELECT COUNT(*) n FROM courses WHERE published=1'),
    students: n("SELECT COUNT(*) n FROM users WHERE role='estudiante'"), enrollments: n('SELECT COUNT(*) n FROM enrollments'),
    orders: n('SELECT COUNT(*) n FROM orders'), pendingOrders: n("SELECT COUNT(*) n FROM orders WHERE status='pendiente'"),
    income: q.get("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status='aprobada'").n,
    certificates: n('SELECT COUNT(*) n FROM certificates WHERE revoked=0'), pendingQa: n('SELECT COUNT(*) n FROM qa WHERE answer IS NULL'),
    messages: n('SELECT COUNT(*) n FROM messages'),
  });
});

// ----- subida de archivos -----
const KINDS: Record<string, { dir: string; max: number; ok: RegExp; msg: string }> = {
  image: { dir: 'images', max: 8, ok: /\.(jpe?g|png|webp|gif|svg)$/i, msg: 'Sube una imagen JPG, PNG o WEBP.' },
  video: { dir: 'videos', max: 2048, ok: /\.(mp4|webm|mov|m4v)$/i, msg: 'Sube un video MP4 o WEBM.' },
  file: { dir: 'files', max: 50, ok: /\.(pdf|docx?|xlsx?|pptx?|zip|txt|csv|png|jpe?g)$/i, msg: 'Tipo de archivo no permitido (usa PDF, Word, Excel, PowerPoint, ZIP o imagen).' },
};
r.post('/upload/:kind', (req, res, next) => {
  const k = KINDS[req.params.kind];
  if (!k) return next(new HttpError(400, 'Tipo de subida desconocido.'));
  multer({
    storage: multer.diskStorage({ destination: path.join(UPLOAD_DIR, k.dir), filename: (_q, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname).toLowerCase()) }),
    limits: { fileSize: k.max * 1024 * 1024 },
    fileFilter: (_q, f, cb) => (k.ok.test(f.originalname) ? cb(null, true) : cb(new HttpError(400, k.msg))),
  }).single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return next(new HttpError(400, 'No se recibió ningún archivo.'));
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    res.json(req.params.kind === 'video' ? { path: `videos/${req.file.filename}`, name, preview: signMedia(`videos/${req.file.filename}`) } : { url: `/uploads/${k.dir}/${req.file.filename}`, name });
  });
});

// ----- categorías y cupones -----
r.post('/categories', (req, res) => {
  const name = str(req.body.name, 60); if (!name) fail(400, 'Escribe el nombre de la categoría.');
  if (q.get('SELECT 1 FROM categories WHERE slug=?', slugify(name))) fail(409, 'Ya existe una categoría con ese nombre.');
  q.run('INSERT INTO categories (name,slug,icon) VALUES (?,?,?)', name, slugify(name), str(req.body.icon, 20) || 'libro'); res.json({ ok: true });
});
r.put('/categories/:id', (req, res) => { const name = str(req.body.name, 60); if (!name) fail(400, 'Escribe el nombre.'); q.run('UPDATE categories SET name=?, icon=? WHERE id=?', name, str(req.body.icon, 20) || 'libro', id(req)); res.json({ ok: true }); });
r.delete('/categories/:id', (req, res) => {
  if (q.get('SELECT 1 FROM courses WHERE category_id=?', id(req))) fail(400, 'Hay cursos en esta categoría. Cámbialos de categoría antes de eliminarla.');
  q.run('DELETE FROM categories WHERE id=?', id(req)); res.json({ ok: true });
});
r.get('/coupons', (_req, res) => res.json(q.all('SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.coupon_code=c.code) uses FROM coupons c ORDER BY c.id DESC')));
r.post('/coupons', (req, res) => {
  const code = str(req.body.code, 30).toUpperCase().replace(/[^A-Z0-9]/g, ''), percent = Math.round(num(req.body.percent));
  if (code.length < 3) fail(400, 'El código debe tener al menos 3 letras o números.');
  if (percent < 1 || percent > 100) fail(400, 'El descuento debe estar entre 1 y 100 %.');
  if (q.get('SELECT 1 FROM coupons WHERE code=?', code)) fail(409, 'Ya existe un cupón con ese código.');
  q.run('INSERT INTO coupons (code,percent) VALUES (?,?)', code, percent); res.json({ ok: true });
});
r.post('/coupons/:id/toggle', (req, res) => { q.run('UPDATE coupons SET active=1-active WHERE id=?', id(req)); res.json({ ok: true }); });
r.delete('/coupons/:id', (req, res) => { q.run('DELETE FROM coupons WHERE id=?', id(req)); res.json({ ok: true }); });

// ----- cursos -----
r.get('/courses', (_req, res) => res.json(q.all(`SELECT c.id,c.slug,c.title,c.price,c.published,c.image,c.is_demo,cat.name category,
  (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) students, (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) lessons
  FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id ORDER BY c.id DESC`)));

const lessonAdmin = (l: Row): Row => ({ ...l, is_free: !!l.is_free, resources: JSON.parse(l.resources || '[]'), video_preview: l.video_kind === 'file' ? signMedia(l.video_url) : null,
  questions: q.all('SELECT id,text,options,correct_index FROM questions WHERE lesson_id=? ORDER BY position,id', l.id).map((x) => ({ ...x, options: JSON.parse(x.options) })) });
r.get('/courses/:id', (req, res) => {
  const c = courseOut(q.get('SELECT * FROM courses WHERE id=?', id(req))); if (!c) fail(404, 'Curso no encontrado.');
  const lessons = q.all('SELECT * FROM lessons WHERE course_id=? ORDER BY position,id', c.id).map(lessonAdmin);
  c.modules = q.all('SELECT * FROM modules WHERE course_id=? ORDER BY position,id', c.id).map((m) => ({ ...m, lessons: lessons.filter((l) => l.module_id === m.id) }));
  res.json(c);
});
function courseFields(b: Row): any[] {
  const title = str(b.title, 120); if (title.length < 3) fail(400, 'Escribe el título del curso.');
  const price = num(b.price, -1); if (price < 0) fail(400, 'Indica un precio válido (usa 0 para un curso gratuito).');
  return [title, str(b.short_desc, 200), str(b.description, 8000), str(b.instructor, 100), str(b.instructor_title, 100), b.category_id ? Number(b.category_id) : null,
    str(b.level, 40) || 'Principiante', str(b.language, 40) || 'Español', num(b.duration_hours), price, b.old_price ? num(b.old_price) : null, str(b.image, 300) || null,
    lines(b.requirements), lines(b.learn), lines(b.includes), !!b.published, b.has_certificate !== false];
}
const COLS = 'title,short_desc,description,instructor,instructor_title,category_id,level,language,duration_hours,price,old_price,image,requirements,learn,includes,published,has_certificate';
r.post('/courses', (req, res) => {
  const f = courseFields(req.body);
  let slug = slugify(f[0]); while (q.get('SELECT 1 FROM courses WHERE slug=?', slug)) slug = `${slugify(f[0])}-${crypto.randomBytes(2).toString('hex')}`;
  res.json({ id: q.run(`INSERT INTO courses (slug,${COLS}) VALUES (?${',?'.repeat(17)})`, slug, ...f).lastInsertRowid });
});
r.put('/courses/:id', (req, res) => {
  const f = courseFields(req.body);
  if (f[15] && !q.get('SELECT 1 FROM lessons WHERE course_id=?', id(req))) fail(400, 'Agrega al menos una lección antes de publicar el curso.');
  q.run(`UPDATE courses SET ${COLS.split(',').map((c) => `${c}=?`).join(',')}, is_demo=0 WHERE id=?`, ...f, id(req)); res.json({ ok: true });
});
r.delete('/courses/:id', (req, res) => {
  if (q.get('SELECT 1 FROM enrollments WHERE course_id=? UNION SELECT 1 FROM orders WHERE course_id=?', id(req), id(req)))
    fail(400, 'Este curso ya tiene estudiantes o compras. Para retirarlo del catálogo, ocúltalo en lugar de eliminarlo.');
  for (const l of q.all("SELECT video_url FROM lessons WHERE course_id=? AND video_kind='file'", id(req))) fs.unlink(path.join(UPLOAD_DIR, l.video_url), () => {});
  q.run('DELETE FROM courses WHERE id=?', id(req)); res.json({ ok: true });
});

// ----- módulos y lecciones -----
const nextPos = (table: string, col: string, v: number): number => q.get(`SELECT COALESCE(MAX(position),-1)+1 n FROM ${table} WHERE ${col}=?`, v).n;
r.post('/courses/:id/modules', (req, res) => {
  const title = str(req.body.title, 150); if (!title) fail(400, 'Escribe el nombre del módulo.');
  q.run('INSERT INTO modules (course_id,title,position) VALUES (?,?,?)', id(req), title, nextPos('modules', 'course_id', id(req))); res.json({ ok: true });
});
r.put('/modules/:id', (req, res) => { const title = str(req.body.title, 150); if (!title) fail(400, 'Escribe el nombre del módulo.'); q.run('UPDATE modules SET title=? WHERE id=?', title, id(req)); res.json({ ok: true }); });
r.delete('/modules/:id', (req, res) => { q.run('DELETE FROM modules WHERE id=?', id(req)); res.json({ ok: true }); });

function move(table: 'modules' | 'lessons', groupCol: string, req: Request): void {
  const row = q.get(`SELECT * FROM ${table} WHERE id=?`, id(req)); if (!row) fail(404, 'No encontrado.');
  const list = q.all(`SELECT id FROM ${table} WHERE ${groupCol}=? ORDER BY position,id`, row[groupCol]).map((x) => x.id);
  const i = list.indexOf(row.id), j = i + (req.body.dir === 'up' ? -1 : 1);
  if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; q.tx(() => list.forEach((x, p) => q.run(`UPDATE ${table} SET position=? WHERE id=?`, p, x))); }
}
r.post('/modules/:id/move', (req, res) => { move('modules', 'course_id', req); res.json({ ok: true }); });
r.post('/lessons/:id/move', (req, res) => { move('lessons', 'module_id', req); res.json({ ok: true }); });

function saveLesson(b: Row, lessonId: number | bigint | null, mod?: Row): void {
  const title = str(b.title, 150); if (!title) fail(400, 'Escribe el título de la lección.');
  const type = ['video', 'texto', 'cuestionario'].includes(b.type) ? b.type : 'video';
  const vkind = b.video_url ? (b.video_kind === 'file' ? 'file' : 'enlace') : null;
  if (vkind === 'file' && !/^videos\/[a-f0-9]+\.\w+$/.test(b.video_url)) fail(400, 'El video subido no es válido.');
  if (vkind === 'enlace' && !/^https:\/\//.test(b.video_url)) fail(400, 'El enlace del video debe empezar con https://');
  const resources = JSON.stringify((b.resources || []).filter((x: Row) => x?.name && /^(\/uploads\/files\/|https:\/\/)/.test(x.url)).map((x: Row) => ({ name: str(x.name, 120), url: str(x.url, 500) })).slice(0, 20));
  const qs = type === 'cuestionario' ? (b.questions || []).map((x: Row) => ({ text: str(x.text, 500), options: (x.options || []).map((o: unknown) => str(o, 300)).filter(Boolean), correct: Number(x.correct_index) })) : [];
  qs.forEach((x: Row, i: number) => { if (!x.text || x.options.length < 2 || !(x.correct >= 0 && x.correct < x.options.length)) fail(400, `Revisa la pregunta ${i + 1}: necesita texto, al menos 2 opciones y una respuesta correcta marcada.`); });
  const vals = [title, type, vkind, vkind ? str(b.video_url, 500) : null, str(b.content), Math.round(num(b.duration_min)), !!b.is_free && type !== 'cuestionario', Math.min(100, Math.max(1, Math.round(num(b.pass_percent, 70)))), resources];
  q.tx(() => {
    if (lessonId) q.run('UPDATE lessons SET title=?,type=?,video_kind=?,video_url=?,content=?,duration_min=?,is_free=?,pass_percent=?,resources=? WHERE id=?', ...vals, lessonId);
    else lessonId = q.run('INSERT INTO lessons (title,type,video_kind,video_url,content,duration_min,is_free,pass_percent,resources,module_id,course_id,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ...vals, mod.id, mod.course_id, nextPos('lessons', 'module_id', mod.id)).lastInsertRowid;
    q.run('DELETE FROM questions WHERE lesson_id=?', lessonId);
    qs.forEach((x: Row, i: number) => q.run('INSERT INTO questions (lesson_id,text,options,correct_index,position) VALUES (?,?,?,?,?)', lessonId, x.text, JSON.stringify(x.options), x.correct, i));
  });
}
r.post('/modules/:id/lessons', (req, res) => { const m = q.get('SELECT * FROM modules WHERE id=?', id(req)); if (!m) fail(404, 'Módulo no encontrado.'); saveLesson(req.body, null, m); res.json({ ok: true }); });
r.put('/lessons/:id', (req, res) => {
  const old = q.get('SELECT * FROM lessons WHERE id=?', id(req)); if (!old) fail(404, 'Lección no encontrada.');
  saveLesson(req.body, old.id);
  if (old.video_kind === 'file' && old.video_url !== req.body.video_url) fs.unlink(path.join(UPLOAD_DIR, old.video_url), () => {});
  res.json({ ok: true });
});
r.delete('/lessons/:id', (req, res) => {
  const old = q.get('SELECT * FROM lessons WHERE id=?', id(req));
  if (old?.video_kind === 'file') fs.unlink(path.join(UPLOAD_DIR, old.video_url), () => {});
  q.run('DELETE FROM lessons WHERE id=?', id(req)); res.json({ ok: true });
});

// ----- compras -----
r.get('/orders', (req, res) => {
  const rows = q.all(`SELECT o.*, u.name student, u.email, c.title course FROM orders o JOIN users u ON u.id=o.user_id JOIN courses c ON c.id=o.course_id ${req.query.status ? 'WHERE o.status=?' : ''} ORDER BY o.id DESC LIMIT 500`, ...(req.query.status ? [String(req.query.status)] : []));
  res.json(rows.map((o) => ({ ...o, voucher: signMedia(o.voucher) })));
});
const pending = (req: Request): Row => q.get("SELECT * FROM orders WHERE id=? AND status='pendiente'", id(req)) || fail(400, 'Este pedido ya fue procesado.');
r.post('/orders/:id/approve', (req, res) => { approveOrder(pending(req)); res.json({ ok: true }); });
r.post('/orders/:id/reject', (req, res) => {
  const o = pending(req), note = str(req.body.note, 300) || 'No pudimos verificar el pago.';
  q.run("UPDATE orders SET status='rechazada', note=?, updated_at=datetime('now') WHERE id=?", note, o.id);
  const u = q.get('SELECT name,email FROM users WHERE id=?', o.user_id);
  sendMail(u.email, `Tu pedido ${o.code} no pudo ser aprobado`, `Hola ${u.name}:\n\nNo pudimos aprobar tu pedido ${o.code}.\nMotivo: ${note}\n\nPuedes volver a intentarlo desde la página del curso.`);
  res.json({ ok: true });
});

// ----- estudiantes -----
r.get('/students', (_req, res) => {
  const users = q.all("SELECT id,name,email,phone,created_at FROM users WHERE role='estudiante' ORDER BY id DESC LIMIT 1000");
  const en = q.all('SELECT e.user_id,e.course_id,c.title FROM enrollments e JOIN courses c ON c.id=e.course_id');
  res.json(users.map((u) => ({ ...u, courses: en.filter((e) => e.user_id === u.id).map((e) => ({ course_id: e.course_id, title: e.title, percent: courseProgress(u.id, e.course_id).percent })) })));
});
r.post('/enroll', (req, res) => {
  const u = q.get('SELECT id FROM users WHERE email=?', str(req.body.email, 150).toLowerCase()); if (!u) fail(404, 'No hay una cuenta registrada con ese correo.');
  if (!q.get('SELECT 1 FROM courses WHERE id=?', Number(req.body.courseId))) fail(404, 'Curso no encontrado.');
  q.run('INSERT OR IGNORE INTO enrollments (user_id,course_id) VALUES (?,?)', u.id, Number(req.body.courseId)); res.json({ ok: true });
});
r.delete('/enroll/:userId/:courseId', (req, res) => { q.run('DELETE FROM enrollments WHERE user_id=? AND course_id=?', Number(req.params.userId), Number(req.params.courseId)); res.json({ ok: true }); });

// ----- preguntas, reseñas, certificados, mensajes -----
r.get('/qa', (_req, res) => res.json(q.all('SELECT a.*, u.name student, c.title course, l.title lesson FROM qa a JOIN users u ON u.id=a.user_id JOIN courses c ON c.id=a.course_id JOIN lessons l ON l.id=a.lesson_id ORDER BY (a.answer IS NOT NULL), a.id DESC LIMIT 500')));
r.post('/qa/:id/answer', (req, res) => {
  const answer = str(req.body.answer, 3000); if (answer.length < 2) fail(400, 'Escribe la respuesta.');
  q.run("UPDATE qa SET answer=?, answered_by=?, answered_at=datetime('now') WHERE id=?", answer, req.user.name, id(req)); res.json({ ok: true });
});
r.delete('/qa/:id', (req, res) => { q.run('DELETE FROM qa WHERE id=?', id(req)); res.json({ ok: true }); });
r.get('/reviews', (_req, res) => res.json(q.all('SELECT r.*, u.name student, c.title course FROM reviews r JOIN users u ON u.id=r.user_id JOIN courses c ON c.id=r.course_id ORDER BY r.id DESC LIMIT 500')));
r.post('/reviews/:id/toggle', (req, res) => { q.run('UPDATE reviews SET hidden=1-hidden WHERE id=?', id(req)); res.json({ ok: true }); });
r.delete('/reviews/:id', (req, res) => { q.run('DELETE FROM reviews WHERE id=?', id(req)); res.json({ ok: true }); });
r.get('/certificates', (_req, res) => res.json(q.all('SELECT ce.*, u.email, c.title course FROM certificates ce JOIN users u ON u.id=ce.user_id JOIN courses c ON c.id=ce.course_id ORDER BY ce.id DESC LIMIT 1000')));
r.post('/certificates/:id/toggle', (req, res) => { q.run('UPDATE certificates SET revoked=1-revoked WHERE id=?', id(req)); res.json({ ok: true }); });
r.get('/messages', (_req, res) => res.json(q.all('SELECT * FROM messages ORDER BY id DESC LIMIT 300')));
r.delete('/messages/:id', (req, res) => { q.run('DELETE FROM messages WHERE id=?', id(req)); res.json({ ok: true }); });

export default r;
