// Base de datos SQLite (incluida en Node.js, no requiere instalar nada extra).
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(here, '..', 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
for (const d of ['images', 'files', 'videos', 'vouchers']) fs.mkdirSync(path.join(UPLOAD_DIR, d), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'aulapro.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

type Param = string | number | boolean | null | undefined | bigint;
/** Fila genérica devuelta por SQLite. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;
const clean = (p: Param[]) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
export const q = {
  get: (sql: string, ...p: Param[]): Row | undefined => db.prepare(sql).get(...(clean(p) as any[])) as Row | undefined,
  all: (sql: string, ...p: Param[]): Row[] => db.prepare(sql).all(...(clean(p) as any[])) as Row[],
  run: (sql: string, ...p: Param[]) => db.prepare(sql).run(...(clean(p) as any[])),
  tx<T>(fn: () => T): T {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'estudiante', phone TEXT, reset_token TEXT, reset_expires INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, icon TEXT DEFAULT 'libro');
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, short_desc TEXT DEFAULT '', description TEXT DEFAULT '',
  instructor TEXT DEFAULT '', instructor_title TEXT DEFAULT '', category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  level TEXT DEFAULT 'Principiante', language TEXT DEFAULT 'Español', duration_hours REAL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0, old_price REAL, image TEXT, requirements TEXT DEFAULT '[]', learn TEXT DEFAULT '[]', includes TEXT DEFAULT '[]',
  published INTEGER NOT NULL DEFAULT 0, has_certificate INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS modules (id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY, module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'video', video_kind TEXT, video_url TEXT, content TEXT DEFAULT '',
  duration_min INTEGER DEFAULT 0, is_free INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
  pass_percent INTEGER NOT NULL DEFAULT 70, resources TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, text TEXT NOT NULL, options TEXT NOT NULL, correct_index INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS quiz_attempts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, correct INTEGER NOT NULL, total INTEGER NOT NULL, passed INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS coupons (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, percent INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), course_id INTEGER NOT NULL REFERENCES courses(id),
  price REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL, coupon_code TEXT, method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente', operation_ref TEXT, voucher TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS enrollments (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, course_id INTEGER NOT NULL REFERENCES courses(id), last_lesson_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, course_id));
CREATE TABLE IF NOT EXISTS progress (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, status TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(user_id, lesson_id));
CREATE TABLE IF NOT EXISTS qa (id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, question TEXT NOT NULL, answer TEXT, answered_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), answered_at TEXT);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, rating INTEGER NOT NULL, comment TEXT DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(course_id, user_id));
CREATE TABLE IF NOT EXISTS certificates (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), course_id INTEGER NOT NULL REFERENCES courses(id), student_name TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, issued_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, course_id));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

export const slugify = (s: string): string =>
  String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'curso';

// ---------- Datos de demostración (solo la primera vez) ----------
if (!q.get('SELECT id FROM users LIMIT 1')) {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@aulapro.pe';
  const adminPass = process.env.ADMIN_PASSWORD || 'Admin123!';
  q.run("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')", 'Administrador', adminEmail, bcrypt.hashSync(adminPass, 10));
  const demoStudents = ['Estudiante Demo Uno', 'Estudiante Demo Dos'].map((n, i) =>
    q.run('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)', n, `demo${i + 1}@aulapro.pe`, bcrypt.hashSync('Demo1234!', 10)).lastInsertRowid);
  q.run("INSERT INTO coupons (code,percent) VALUES ('DEMO100',100),('BIENVENIDA20',20)");

  const cats: Record<string, number | bigint> = {};
  for (const [name, icon] of [['Marketing', 'maletin'], ['Tecnología', 'codigo'], ['Negocios', 'personas'], ['Desarrollo personal', 'birrete']])
    cats[name] = q.run('INSERT INTO categories (name,slug,icon) VALUES (?,?,?)', name, slugify(name), icon).lastInsertRowid;

  type Temario = [string, string[]][];
type Pregunta = [string, string[], number];
const demo: [string, string, string, number, number, number | null, string, string, string, Temario, Pregunta[]][] = [
    ['Marketing digital desde cero', 'Marketing', 'Principiante', 12, 149, 199, 'Mariana Torres', 'Especialista en marketing', 'Crea campañas que conectan y convierten, paso a paso.',
      [['Fundamentos del marketing digital', ['¿Qué es el marketing digital?', 'Tu cliente ideal']], ['Canales y contenido', ['Redes sociales que venden', 'Calendario de contenidos']], ['Campañas y medición', ['Tu primera campaña pagada', 'Métricas que importan']]],
      [['¿Qué describe mejor a un "cliente ideal"?', ['Cualquier persona con internet', 'El perfil de quien más se beneficia de tu oferta', 'Tu competidor principal'], 1], ['¿Qué métrica indica cuántas personas compraron tras ver un anuncio?', ['Alcance', 'Tasa de conversión', 'Impresiones'], 1]]],
    ['Desarrollo web profesional', 'Tecnología', 'Intermedio', 24, 199, null, 'Diego Salazar', 'Desarrollador full stack', 'Construye sitios modernos con HTML, CSS y React.',
      [['Bases de la web', ['HTML semántico', 'CSS moderno y responsivo']], ['JavaScript en práctica', ['Variables, funciones y eventos', 'Consumir una API']], ['React', ['Componentes y estado', 'Publica tu proyecto']]],
      [['¿Qué etiqueta HTML representa el contenido principal de una página?', ['<div>', '<main>', '<span>'], 1], ['En React, ¿qué hook guarda estado local?', ['useState', 'useRoute', 'useFetch'], 0]]],
    ['Liderazgo y negocios', 'Negocios', 'Todos los niveles', 10, 129, null, 'Carla Mendoza', 'Consultora de negocios', 'Convierte ideas en planes claros y equipos alineados.',
      [['Visión y estrategia', ['Define tu propuesta de valor', 'Objetivos que se cumplen']], ['Equipos', ['Delegar con claridad', 'Reuniones efectivas']], ['Ejecución', ['Indicadores simples', 'Plan de 90 días']]],
      [['Un buen objetivo debe ser…', ['Ambiguo para dar libertad', 'Medible y con fecha', 'Secreto'], 1], ['Delegar bien implica…', ['Entregar la tarea sin contexto', 'Definir resultado esperado y plazo', 'Hacerlo todo uno mismo'], 1]]],
    ['Excel para el trabajo', 'Tecnología', 'Principiante', 8, 99, 129, 'Diego Salazar', 'Desarrollador full stack', 'Domina fórmulas, tablas y reportes que ahorran horas.',
      [['Primeros pasos', ['Celdas, rangos y formatos', 'Fórmulas esenciales']], ['Análisis', ['Tablas dinámicas', 'Gráficos claros']], ['Productividad', ['Atajos y validaciones', 'Tu reporte mensual']]],
      [['¿Qué función suma un rango?', ['=SUMA()', '=CONTAR()', '=BUSCARV()'], 0], ['Una tabla dinámica sirve para…', ['Resumir grandes volúmenes de datos', 'Cambiar el color de la hoja', 'Proteger el archivo'], 0]]],
    ['Ventas por WhatsApp', 'Marketing', 'Todos los niveles', 6, 89, null, 'Mariana Torres', 'Especialista en marketing', 'Atiende, da seguimiento y cierra ventas desde tu celular.',
      [['Prepara tu canal', ['Perfil de empresa y catálogo', 'Mensajes de bienvenida']], ['Conversaciones que venden', ['Cómo responder objeciones', 'Seguimiento sin ser invasivo']], ['Orden y escala', ['Etiquetas y listas', 'Mide tus cierres']]],
      [['¿Qué ayuda más a cerrar una venta?', ['Responder tarde', 'Dar seguimiento oportuno', 'Enviar mensajes masivos sin permiso'], 1], ['Las etiquetas sirven para…', ['Organizar a tus contactos por etapa', 'Borrar chats', 'Cambiar tu foto'], 0]]],
    ['Hábitos y productividad', 'Desarrollo personal', 'Principiante', 5, 79, null, 'Carla Mendoza', 'Consultora de negocios', 'Organiza tu semana y avanza en lo que importa.',
      [['Claridad', ['Tus prioridades reales', 'Planifica la semana']], ['Enfoque', ['Bloques de trabajo', 'Maneja las distracciones']], ['Constancia', ['Hábitos pequeños', 'Revisión semanal']]],
      [['Un hábito es más fácil de sostener si…', ['Es pequeño y concreto', 'Depende de la motivación', 'Cambia todos los días'], 0], ['La revisión semanal sirve para…', ['Ajustar el plan según lo aprendido', 'Castigarse', 'Llenar la agenda'], 0]]],
  ];
  demo.forEach(([title, cat, level, hours, price, old, inst, instT, short, temario, preguntas], i) => {
    const slug = slugify(title);
    const cid = q.run(
      `INSERT INTO courses (slug,title,short_desc,description,instructor,instructor_title,category_id,level,duration_hours,price,old_price,image,requirements,learn,includes,published,is_demo,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,datetime('now', ?))`,
      slug, title, short,
      `${short}\n\nEste es un curso de demostración para que conozcas cómo funciona la plataforma. Desde el panel de administración puedes editarlo, reemplazar sus lecciones y videos, o eliminarlo.`,
      inst, instT, cats[cat], level, hours, price, old, `/img/curso-${i + 1}.svg`,
      JSON.stringify(['Computadora o celular con internet', 'Ganas de aprender y practicar']),
      JSON.stringify(temario.map(([m]) => `Dominar: ${m.toLowerCase()}`).concat('Aplicar lo aprendido en un caso práctico')),
      JSON.stringify(['Acceso de por vida', 'Lecciones en video y lectura', 'Examen final', 'Certificado verificable con código QR']),
      `-${i} days`).lastInsertRowid;
    let first = true;
    temario.forEach(([mt, ls], mi) => {
      const mid = q.run('INSERT INTO modules (course_id,title,position) VALUES (?,?,?)', cid, `Tema ${mi + 1}: ${mt}`, mi).lastInsertRowid;
      ls.forEach((lt, li) => {
        q.run('INSERT INTO lessons (module_id,course_id,title,type,content,duration_min,is_free,position) VALUES (?,?,?,?,?,?,?,?)',
          mid, cid, lt, li === 0 ? 'video' : 'texto',
          `Lección de demostración: «${lt}».\n\nAquí aparecerá el contenido que el administrador escriba para esta lección: explicaciones, pasos, enlaces y materiales descargables.`,
          10 + li * 5, first, li);
        first = false;
      });
    });
    const mid = q.run('INSERT INTO modules (course_id,title,position) VALUES (?,?,?)', cid, 'Examen', 99).lastInsertRowid;
    const lid = q.run("INSERT INTO lessons (module_id,course_id,title,type,content,duration_min,position,pass_percent) VALUES (?,?,?,'cuestionario',?,15,0,70)",
      mid, cid, 'Examen final', 'Responde las preguntas para completar el curso.').lastInsertRowid;
    preguntas.forEach(([t, o, c], pi) => q.run('INSERT INTO questions (lesson_id,text,options,correct_index,position) VALUES (?,?,?,?,?)', lid, t, JSON.stringify(o), c, pi));
    if (i < 3) demoStudents.forEach((uid, k) => {
      q.run('INSERT INTO enrollments (user_id,course_id) VALUES (?,?)', uid, cid);
      q.run('INSERT INTO reviews (course_id,user_id,rating,comment) VALUES (?,?,?,?)', cid, uid, 5 - ((i + k) % 2),
        k ? 'Reseña de demostración: contenido claro y fácil de seguir.' : 'Reseña de demostración: pude aplicar lo aprendido desde la primera semana.');
    });
  });
  console.log(`\n  Datos de demostración creados.\n  Administrador: ${adminEmail} / ${adminPass}  (cambia la contraseña al ingresar)\n  Estudiante demo: demo1@aulapro.pe / Demo1234!\n`);
}
