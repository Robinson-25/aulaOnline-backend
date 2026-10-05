import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { q, UPLOAD_DIR, type Row } from './db.ts';
import { type User, HttpError, fail, signUser, publicUser, loadUser, requireAuth, signMedia, readMedia, limit } from './auth.ts';
import { SITE, PUBLIC_URL, randomCode, courseProgress, ensureCertificate, certificatePdf } from './cert.ts';
import { sendMail, mailConfigured } from './mail.ts';
import { store } from './storage.ts';
import { events, notifyChanges } from './live.ts';
import adminRoutes from './admin.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
// CORS: por defecto acepta cualquier origen; en producción limita con CORS_ORIGINS=https://tusitio.com,https://admin.tusitio.com
app.use(cors(process.env.CORS_ORIGINS ? { origin: process.env.CORS_ORIGINS.split(',').map((s) => s.trim()) } : undefined));
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { req.body ??= {}; next(); });
app.use(async (_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); next(); });
app.use('/img', express.static(path.join(here, '..', 'public', 'img'), { maxAge: '7d' }));
app.use('/uploads/images', express.static(path.join(UPLOAD_DIR, 'images'), { maxAge: '7d' }));
app.use('/uploads/files', express.static(path.join(UPLOAD_DIR, 'files')));
app.use(loadUser);
app.get('/api/events', events);
app.use('/api', notifyChanges);

// ---------- utilidades ----------
const str = (v: unknown, max = 5000): string => String(v ?? '').trim().slice(0, max);
const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const checkPassword = (p: unknown): string => (typeof p === 'string' && p.length >= 8 ? p : fail(400, 'La contraseña debe tener al menos 8 caracteres.'));
const E = process.env;
export const paymentMethods = () => [
  E.YAPE_NUMERO && { id: 'yape', name: 'Yape', number: E.YAPE_NUMERO, holder: E.YAPE_TITULAR || '' },
  E.PLIN_NUMERO && { id: 'plin', name: 'Plin', number: E.PLIN_NUMERO, holder: E.PLIN_TITULAR || '' },
  E.BANCO_CUENTA && { id: 'transferencia', name: 'Transferencia bancaria', bank: E.BANCO_NOMBRE || '', account: E.BANCO_CUENTA, cci: E.BANCO_CCI || '', holder: E.BANCO_TITULAR || '' },
].filter(Boolean);

const COURSE_SQL = `SELECT c.*, cat.name category, cat.slug category_slug,
  (SELECT ROUND(AVG(rating),1) FROM reviews r WHERE r.course_id=c.id AND r.hidden=0) rating,
  (SELECT COUNT(*) FROM reviews r WHERE r.course_id=c.id AND r.hidden=0) reviews_count,
  (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) students
  FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id`;
export const courseOut = (c: Row | undefined): Row | undefined => c && ({ ...c, requirements: JSON.parse(c.requirements || '[]'), learn: JSON.parse(c.learn || '[]'), includes: JSON.parse(c.includes || '[]'), published: !!c.published, has_certificate: !!c.has_certificate, is_demo: !!c.is_demo });
const isEnrolled = async (user: User | null | undefined, courseId: number): Promise<boolean> => !!user && !!(await q.get('SELECT 1 FROM enrollments WHERE user_id=? AND course_id=?', user.id, courseId));
const canStudy = async (user: User | null | undefined, courseId: number): Promise<boolean> => user?.role === 'admin' || (await isEnrolled(user, courseId));

export async function approveOrder(order: Row): Promise<void> {
  (await q.run("UPDATE orders SET status='aprobada', updated_at=NOW() WHERE id=?", order.id));
  (await q.run('INSERT IGNORE INTO enrollments (user_id,course_id) VALUES (?,?)', order.user_id, order.course_id));
  const u = (await q.get('SELECT name,email FROM users WHERE id=?', order.user_id)), c = (await q.get('SELECT title,slug FROM courses WHERE id=?', order.course_id));
  sendMail(u.email, `Comprobante de compra ${order.code} — ${SITE}`,
    `Hola ${u.name}:\n\nTu compra fue aprobada.\n\nPedido: ${order.code}\nCurso: ${c.title}\nTotal pagado: S/ ${order.total.toFixed(2)}\nMétodo: ${order.method}\n\nYa puedes estudiar: ${PUBLIC_URL}/aula/${c.slug}\n\n${SITE}`);
}

// ---------- configuración pública ----------
app.get('/api/config', async (_req, res) => res.json({
  site: SITE, methods: paymentMethods(), card: { available: false }, mail: mailConfigured,
  reviewNeedsCompletion: E.RESENA_REQUIERE_COMPLETAR === 'true',
}));
app.get('/api/categories', async (_req, res) =>
  res.json((await q.all('SELECT cat.*, (SELECT COUNT(*) FROM courses c WHERE c.category_id=cat.id AND c.published=1) courses FROM categories cat ORDER BY cat.name'))));

// ---------- catálogo ----------
app.get('/api/courses', async (req, res) => {
  const { q: text, category, level, maxPrice, duration, rating, sort } = req.query;
  let list = (await q.all(`${COURSE_SQL} WHERE c.published=1`)).map((c) => courseOut(c) as Row);
  const norm = (s: unknown) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (text) { const t = norm(text); list = list.filter((c) => [c.title, c.short_desc, c.instructor, c.category].some((f) => norm(f).includes(t))); }
  if (category) list = list.filter((c) => c.category_slug === category);
  if (level) list = list.filter((c) => c.level === level);
  if (maxPrice) list = list.filter((c) => c.price <= Number(maxPrice));
  if (duration === 'corta') list = list.filter((c) => c.duration_hours <= 6);
  if (duration === 'media') list = list.filter((c) => c.duration_hours > 6 && c.duration_hours <= 15);
  if (duration === 'larga') list = list.filter((c) => c.duration_hours > 15);
  if (rating) list = list.filter((c) => (c.rating || 0) >= Number(rating));
  const by: Record<string, (a: Row, b: Row) => number> = { precio_asc: (a, b) => a.price - b.price, precio_desc: (a, b) => b.price - a.price, recientes: (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id };
  list.sort(by[String(sort)] || ((a, b) => b.students - a.students || b.reviews_count - a.reviews_count));
  res.json(list);
});

app.get('/api/courses/:slug', async (req, res) => {
  const c = courseOut((await q.get(`${COURSE_SQL} WHERE c.slug=?`, String(req.params.slug))));
  if (!c || (!c.published && req.user?.role !== 'admin')) fail(404, 'No encontramos este curso.');
  const lessons = (await q.all('SELECT id,module_id,title,type,duration_min,is_free FROM lessons WHERE course_id=? ORDER BY position,id', c.id));
  c.modules = (await q.all('SELECT id,title FROM modules WHERE course_id=? ORDER BY position,id', c.id)).map((m) => ({ ...m, lessons: lessons.filter((l) => l.module_id === m.id) }));
  c.reviews = (await q.all('SELECT r.id,r.rating,r.comment,r.created_at,u.name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.course_id=? AND r.hidden=0 ORDER BY r.created_at DESC LIMIT 50', c.id));
  c.enrolled = (await isEnrolled(req.user, c.id));
  c.pendingOrder = req.user ? (await q.get("SELECT code FROM orders WHERE user_id=? AND course_id=? AND status='pendiente'", req.user.id, c.id)) || null : null;
  res.json(c);
});

app.get('/api/reviews/featured', async (_req, res) =>
  res.json((await q.all("SELECT r.rating,r.comment,u.name,c.title course FROM reviews r JOIN users u ON u.id=r.user_id JOIN courses c ON c.id=r.course_id WHERE r.hidden=0 AND r.rating>=4 AND r.comment<>'' AND c.published=1 ORDER BY r.created_at DESC LIMIT 3"))));

app.post('/api/contact', limit(5, 10), async (req, res) => {
  const name = str(req.body.name, 100), email = str(req.body.email, 150).toLowerCase(), message = str(req.body.message, 2000);
  if (!name || !isEmail(email) || message.length < 5) fail(400, 'Completa tu nombre, un correo válido y tu mensaje.');
  (await q.run('INSERT INTO messages (name,email,message) VALUES (?,?,?)', name, email, message));
  res.json({ ok: true });
});

// ---------- cuentas ----------
app.post('/api/auth/register', limit(10, 10), async (req, res) => {
  const name = str(req.body.name, 100), email = str(req.body.email, 150).toLowerCase();
  if (name.length < 3) fail(400, 'Escribe tu nombre completo (aparecerá en tu certificado).');
  if (!isEmail(email)) fail(400, 'Escribe un correo electrónico válido.');
  checkPassword(req.body.password);
  if ((await q.get('SELECT 1 FROM users WHERE email=?', email))) fail(409, 'Ya existe una cuenta con este correo. Inicia sesión.');
  const id = (await q.run('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)', name, email, bcrypt.hashSync(req.body.password, 10))).lastInsertRowid;
  const u = (await q.get('SELECT * FROM users WHERE id=?', id));
  res.json({ token: signUser(u), user: publicUser(u) });
});
app.post('/api/auth/login', limit(10, 10), async (req, res) => {
  const u = (await q.get('SELECT * FROM users WHERE email=?', str(req.body.email, 150).toLowerCase()));
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) fail(401, 'Correo o contraseña incorrectos.');
  res.json({ token: signUser(u), user: publicUser(u) });
});
app.post('/api/auth/forgot', limit(5, 15), async (req, res) => {
  const u = (await q.get('SELECT * FROM users WHERE email=?', str(req.body.email, 150).toLowerCase()));
  if (u) {
    const token = crypto.randomBytes(32).toString('hex');
    (await q.run('UPDATE users SET reset_token=?, reset_expires=? WHERE id=?', crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 3600000, u.id));
    sendMail(u.email, `Restablece tu contraseña — ${SITE}`, `Hola ${u.name}:\n\nPara crear una nueva contraseña abre este enlace (válido por 1 hora):\n${PUBLIC_URL}/restablecer/${token}\n\nSi no lo solicitaste, ignora este mensaje.`);
  }
  res.json({ ok: true }); // misma respuesta exista o no la cuenta
});
app.post('/api/auth/reset', limit(10, 15), async (req, res) => {
  const hash = crypto.createHash('sha256').update(String(req.body.token || '')).digest('hex');
  const u = (await q.get('SELECT * FROM users WHERE reset_token=? AND reset_expires>?', hash, Date.now()));
  if (!u) fail(400, 'El enlace ya no es válido. Solicita uno nuevo.');
  (await q.run('UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?', bcrypt.hashSync(checkPassword(req.body.password), 10), u.id));
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, async (req, res) => res.json(publicUser(req.user)));
app.put('/api/me', requireAuth, async (req, res) => {
  const name = str(req.body.name, 100);
  if (name.length < 3) fail(400, 'Escribe tu nombre completo.');
  (await q.run('UPDATE users SET name=?, phone=? WHERE id=?', name, str(req.body.phone, 30), req.user.id));
  res.json(publicUser((await q.get('SELECT * FROM users WHERE id=?', req.user.id))));
});
app.put('/api/me/password', requireAuth, async (req, res) => {
  if (!bcrypt.compareSync(String(req.body.current || ''), req.user.password_hash)) fail(400, 'Tu contraseña actual no es correcta.');
  (await q.run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(checkPassword(req.body.password), 10), req.user.id));
  res.json({ ok: true });
});

// ---------- compra ----------
const findCoupon = async (code: unknown): Promise<Row | null> => (code ? (await q.get('SELECT * FROM coupons WHERE code=? AND active=1', str(code, 40).toUpperCase())) : null);
app.post('/api/coupons/check', requireAuth, async (req, res) => {
  const c = (await findCoupon(req.body.code));
  if (!c) fail(404, 'Este cupón no es válido o ya no está activo.');
  res.json({ code: c.code, percent: c.percent });
});

const voucherUpload = multer({
  storage: multer.diskStorage({ destination: path.join(UPLOAD_DIR, 'vouchers'), filename: (_r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => (/\.(jpe?g|png|webp|pdf)$/i.test(f.originalname) ? cb(null, true) : cb(new HttpError(400, 'El comprobante debe ser una imagen (JPG, PNG) o un PDF.'))),
}).single('voucher');

app.post('/api/orders', requireAuth, voucherUpload, async (req, res) => {
  let stored = false;
  const drop = () => req.file && !stored && fs.unlink(req.file.path, () => {});
  try {
    const course = (await q.get('SELECT * FROM courses WHERE id=? AND published=1', Number(req.body.courseId)));
    if (!course) fail(404, 'Este curso no está disponible.');
    if ((await isEnrolled(req.user, course.id))) fail(409, 'Ya tienes este curso en tu cuenta.');
    if ((await q.get("SELECT 1 FROM orders WHERE user_id=? AND course_id=? AND status='pendiente'", req.user.id, course.id))) fail(409, 'Ya tienes un pedido pendiente de este curso. Revísalo en "Mis compras".');
    const coupon = (await findCoupon(req.body.coupon));
    if (req.body.coupon && !coupon) fail(400, 'El cupón no es válido.');
    const discount = coupon ? Math.round(course.price * coupon.percent) / 100 : 0;
    const total = Math.max(0, Math.round((course.price - discount) * 100) / 100);
    const free = total === 0;
    const method = free ? 'gratis' : str(req.body.method, 30);
    const ref = str(req.body.operationRef, 60);
    if (!free) {
      if (!paymentMethods().some((m) => m.id === method)) fail(400, 'Selecciona un método de pago disponible.');
      if (ref.length < 4 && !req.file) fail(400, 'Ingresa el número de operación o adjunta tu comprobante de pago.');
    }
    // El comprobante se guarda solo cuando el pedido ya pasó todas las validaciones.
    let voucher: string | null = null;
    if (!free && req.file) { voucher = (await store(req.file.path, 'vouchers')).ref; stored = true; }
    let code: string;
    do code = randomCode('PED', 7); while ((await q.get('SELECT 1 FROM orders WHERE code=?', code)));
    const id = (await q.run('INSERT INTO orders (code,user_id,course_id,price,discount,total,coupon_code,method,operation_ref,voucher) VALUES (?,?,?,?,?,?,?,?,?,?)',
      code, req.user.id, course.id, course.price, discount, total, coupon?.code, method, ref || null, voucher)).lastInsertRowid;
    const order = (await q.get('SELECT * FROM orders WHERE id=?', id));
    if (free) { drop(); (await approveOrder(order)); } // sin cobro: no hay pago que confirmar
    else sendMail(req.user.email, `Recibimos tu pedido ${code} — ${SITE}`, `Hola ${req.user.name}:\n\nRegistramos tu pedido ${code} del curso "${course.title}" por S/ ${total.toFixed(2)}.\nEstado: pendiente de verificación. Te avisaremos cuando confirmemos tu pago.\n\n${SITE}`);
    res.json({ code, status: free ? 'aprobada' : 'pendiente', slug: course.slug });
  } catch (e) { drop(); throw e; }
});
app.get('/api/orders/mine', requireAuth, async (req, res) =>
  res.json((await q.all('SELECT o.id,o.code,o.price,o.discount,o.total,o.coupon_code,o.method,o.status,o.note,o.operation_ref,o.created_at,c.title,c.slug FROM orders o JOIN courses c ON c.id=o.course_id WHERE o.user_id=? ORDER BY o.id DESC', req.user.id))));
app.post('/api/orders/:id/cancel', requireAuth, async (req, res) => {
  const r = (await q.run("UPDATE orders SET status='cancelada', updated_at=NOW() WHERE id=? AND user_id=? AND status='pendiente'", Number(req.params.id), req.user.id));
  if (!r.changes) fail(400, 'Este pedido ya no se puede cancelar.');
  res.json({ ok: true });
});

// ---------- cuenta del estudiante ----------
app.get('/api/my/courses', requireAuth, async (req, res) => {
  const rows = (await q.all('SELECT c.id,c.slug,c.title,c.image,c.instructor,e.last_lesson_id,e.created_at enrolled_at FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? ORDER BY e.id DESC', req.user.id));
  const out = [];
  for (const c of rows) out.push({ ...c, ...(await courseProgress(req.user.id, c.id)), last_lesson: c.last_lesson_id ? (await q.get('SELECT title FROM lessons WHERE id=?', c.last_lesson_id))?.title || null : null });
  res.json(out);
});
app.get('/api/my/certificates', requireAuth, async (req, res) =>
  res.json((await q.all('SELECT ce.code,ce.issued_at,ce.revoked,c.title FROM certificates ce JOIN courses c ON c.id=ce.course_id WHERE ce.user_id=? ORDER BY ce.id DESC', req.user.id))));

// ---------- aula virtual ----------
app.get('/api/learn/:slug', requireAuth, async (req, res) => {
  const c = (await q.get('SELECT id,slug,title,instructor,has_certificate FROM courses WHERE slug=?', String(req.params.slug)));
  if (!c) fail(404, 'No encontramos este curso.');
  if (!(await canStudy(req.user, c.id))) fail(403, 'Aún no tienes acceso a este curso. Se activará cuando tu compra sea aprobada.');
  const st = Object.fromEntries((await q.all('SELECT p.lesson_id,p.status FROM progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=? AND l.course_id=?', req.user.id, c.id)).map((r) => [r.lesson_id, r.status]));
  const lessons = (await q.all('SELECT id,module_id,title,type,duration_min FROM lessons WHERE course_id=? ORDER BY position,id', c.id)).map((l) => ({ ...l, status: st[l.id] || 'pendiente' }));
  const modules = (await q.all('SELECT id,title FROM modules WHERE course_id=? ORDER BY position,id', c.id)).map((m) => ({ ...m, lessons: lessons.filter((l) => l.module_id === m.id) }));
  const en = (await q.get('SELECT last_lesson_id FROM enrollments WHERE user_id=? AND course_id=?', req.user.id, c.id));
  res.json({ ...c, modules, progress: (await courseProgress(req.user.id, c.id)), last_lesson_id: en?.last_lesson_id || null,
    certificate: (await q.get('SELECT code,revoked FROM certificates WHERE user_id=? AND course_id=?', req.user.id, c.id)) || null,
    myReview: (await q.get('SELECT rating,comment FROM reviews WHERE user_id=? AND course_id=?', req.user.id, c.id)) || null });
});

const getLesson = async (id: unknown): Promise<Row> => (await q.get('SELECT * FROM lessons WHERE id=?', Number(id))) || fail(404, 'No encontramos esta lección.');
app.get('/api/lessons/:id', async (req, res) => {
  const l = (await getLesson(req.params.id));
  const study = (await canStudy(req.user, l.course_id));
  if (!study && !l.is_free) fail(req.user ? 403 : 401, 'Esta lección está disponible al comprar el curso.');
  const out: Row = { id: l.id, title: l.title, type: l.type, content: l.content, duration_min: l.duration_min, resources: JSON.parse(l.resources || '[]'), pass_percent: l.pass_percent,
    video: l.video_url ? { kind: l.video_kind, url: l.video_kind === 'file' ? signMedia(l.video_url) : l.video_url } : null };
  if (l.type === 'cuestionario') {
    out.questions = (await q.all('SELECT id,text,options FROM questions WHERE lesson_id=? ORDER BY position,id', l.id)).map((x) => ({ ...x, options: JSON.parse(x.options) }));
    out.attempts = req.user ? (await q.all('SELECT correct,total,passed,created_at FROM quiz_attempts WHERE user_id=? AND lesson_id=? ORDER BY id DESC LIMIT 10', req.user.id, l.id)) : [];
  }
  if ((await isEnrolled(req.user, l.course_id))) {
    (await q.run("INSERT IGNORE INTO progress (user_id,lesson_id,status) VALUES (?,?,'en_progreso')", req.user.id, l.id));
    (await q.run('UPDATE enrollments SET last_lesson_id=? WHERE user_id=? AND course_id=?', l.id, req.user.id, l.course_id));
  }
  res.json(out);
});
app.get('/api/media', async (req, res) => {
  const f = readMedia(String(req.query.f || ''));
  if (!f) fail(403, 'El enlace venció. Recarga la página.');
  res.sendFile(f, { root: UPLOAD_DIR, dotfiles: 'deny' }, (err) => err && !res.headersSent && res.status(404).end());
});

const finish = async (req: Request, res: Response, l: Row, extra: object = {}) => {
  const user = req.user as User;
  const certificate = (await ensureCertificate(user, l.course_id));
  res.json({ ...extra, progress: (await courseProgress(user.id, l.course_id)), certificate: certificate ? { code: certificate.code, revoked: certificate.revoked } : null });
};
const enrolledLesson = async (req: Request): Promise<Row> => { const l = (await getLesson(req.params.id)); if (!(await isEnrolled(req.user, l.course_id))) fail(403, 'Necesitas estar matriculado en este curso.'); return l; };
app.post('/api/lessons/:id/complete', requireAuth, async (req, res) => {
  const l = (await enrolledLesson(req));
  if (l.type === 'cuestionario') fail(400, 'Debes aprobar el cuestionario para completar esta lección.');
  (await q.run("INSERT INTO progress (user_id,lesson_id,status) VALUES (?,?,'completada') ON DUPLICATE KEY UPDATE status='completada', updated_at=NOW()", req.user.id, l.id));
  (await finish(req, res, l));
});
app.post('/api/lessons/:id/quiz', requireAuth, async (req, res) => {
  const l = (await enrolledLesson(req));
  const qs = (await q.all('SELECT id,correct_index FROM questions WHERE lesson_id=? ORDER BY position,id', l.id));
  if (l.type !== 'cuestionario' || !qs.length) fail(400, 'Este cuestionario todavía no tiene preguntas.');
  const answers = req.body.answers || {};
  if (qs.some((x) => !Number.isInteger(answers[x.id]))) fail(400, 'Responde todas las preguntas antes de enviar.');
  const correct = qs.filter((x) => answers[x.id] === x.correct_index).length;
  const percent = Math.round((correct / qs.length) * 100), passed = percent >= l.pass_percent;
  (await q.run('INSERT INTO quiz_attempts (user_id,lesson_id,correct,total,passed) VALUES (?,?,?,?,?)', req.user.id, l.id, correct, qs.length, passed));
  if (passed) (await q.run("INSERT INTO progress (user_id,lesson_id,status) VALUES (?,?,'completada') ON DUPLICATE KEY UPDATE status='completada', updated_at=NOW()", req.user.id, l.id));
  (await finish(req, res, l, { correct, total: qs.length, percent, passed, results: Object.fromEntries(qs.map((x) => [x.id, answers[x.id] === x.correct_index])) }));
});

// preguntas y respuestas (solo matriculados y administradores)
app.get('/api/lessons/:id/qa', requireAuth, async (req, res) => {
  const l = (await getLesson(req.params.id));
  if (!(await canStudy(req.user, l.course_id))) fail(403, 'Solo los estudiantes del curso pueden ver las preguntas.');
  res.json((await q.all('SELECT a.id,a.question,a.answer,a.answered_by,a.created_at,a.answered_at,u.name,a.user_id FROM qa a JOIN users u ON u.id=a.user_id WHERE a.lesson_id=? ORDER BY a.id DESC', l.id))
    .map(({ user_id, ...r }) => ({ ...r, mine: user_id === req.user.id })));
});
const qText = (b: Row): string => { const t = str(b.question, 1500); return t.length >= 5 ? t : fail(400, 'Escribe tu pregunta (mínimo 5 caracteres).'); };
app.post('/api/lessons/:id/qa', requireAuth, async (req, res) => {
  const l = (await enrolledLesson(req));
  (await q.run('INSERT INTO qa (course_id,lesson_id,user_id,question) VALUES (?,?,?,?)', l.course_id, l.id, req.user.id, qText(req.body)));
  res.json({ ok: true });
});
const myOpenQuestion = async (req: Request): Promise<Row> => (await q.get('SELECT * FROM qa WHERE id=? AND user_id=? AND answer IS NULL', Number(req.params.id), req.user.id)) || fail(400, 'Solo puedes modificar tus preguntas que aún no tienen respuesta.');
app.put('/api/qa/:id', requireAuth, async (req, res) => { (await q.run('UPDATE qa SET question=? WHERE id=?', qText(req.body), (await myOpenQuestion(req)).id)); res.json({ ok: true }); });
app.delete('/api/qa/:id', requireAuth, async (req, res) => { (await q.run('DELETE FROM qa WHERE id=?', (await myOpenQuestion(req)).id)); res.json({ ok: true }); });

// reseñas: una por estudiante y curso (se puede editar)
app.post('/api/courses/:id/review', requireAuth, async (req, res) => {
  const courseId = Number(req.params.id), rating = Number(req.body.rating);
  if (!(await isEnrolled(req.user, courseId))) fail(403, 'Solo los estudiantes matriculados pueden dejar una reseña.');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'Elige una calificación de 1 a 5 estrellas.');
  const p = (await courseProgress(req.user.id, courseId));
  if (E.RESENA_REQUIERE_COMPLETAR === 'true' ? p.done < p.total : !(await q.get('SELECT 1 FROM progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=? AND l.course_id=?', req.user.id, courseId)))
    fail(400, E.RESENA_REQUIERE_COMPLETAR === 'true' ? 'Podrás dejar tu reseña al completar el curso.' : 'Empieza el curso para poder dejar tu reseña.');
  (await q.run("INSERT INTO reviews (course_id,user_id,rating,comment) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE rating=VALUES(rating), comment=VALUES(comment)", courseId, req.user.id, rating, str(req.body.comment, 1000)));
  res.json({ ok: true });
});

// ---------- certificados (verificación pública: solo datos mínimos) ----------
app.get('/api/verify/:code', async (req, res) => {
  const c = (await q.get('SELECT ce.code,ce.student_name,ce.issued_at,ce.revoked,co.title course,co.instructor FROM certificates ce JOIN courses co ON co.id=ce.course_id WHERE ce.code=?', str(req.params.code, 30).toUpperCase()));
  if (!c) fail(404, 'No existe un certificado con este código.');
  res.json({ ...c, revoked: !!c.revoked, valid: !c.revoked, site: SITE });
});
app.get('/api/certificates/:code/pdf', async (req, res, next) => {
  try {
    const c = (await q.get('SELECT * FROM certificates WHERE code=?', str(req.params.code, 30).toUpperCase()));
    if (!c) fail(404, 'No existe un certificado con este código.');
    await certificatePdf(c, res);
  } catch (e) { next(e); }
});

app.use('/api/admin', adminRoutes);
app.use('/api', async (_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada.')));

app.get('/', async (_req, res) => res.json({ api: SITE, estado: 'ok' }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo es demasiado grande.' : 'No se pudo subir el archivo.' });
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err instanceof HttpError ? err.message : 'Ocurrió un error inesperado. Inténtalo de nuevo.' });
});

const PORT = Number(E.PORT || 4000);
app.listen(PORT, () => console.log(`${SITE} — API lista en http://localhost:${PORT}`));
