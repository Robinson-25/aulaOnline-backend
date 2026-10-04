// Base de datos MySQL (compatible con Clever Cloud, MariaDB y MySQL 8).
import mysql, { type PoolConnection, type ResultSetHeader } from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Los archivos subidos (videos, imágenes, comprobantes) se guardan en disco, no en la base de datos.
export const DATA_DIR = process.env.DATA_DIR || path.join(here, '..', 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
for (const d of ['images', 'files', 'videos', 'vouchers']) fs.mkdirSync(path.join(UPLOAD_DIR, d), { recursive: true });

// Conexión: usa los datos de backend/.env (DB_*) o, si la app corre en Clever Cloud
// con el add-on enlazado, las variables MYSQL_ADDON_* que Clever Cloud crea solo.
const E = process.env;
const config = {
  host: E.DB_HOST || E.MYSQL_ADDON_HOST,
  port: Number(E.DB_PORT || E.MYSQL_ADDON_PORT || 3306),
  database: E.DB_NAME || E.MYSQL_ADDON_DB,
  user: E.DB_USER || E.MYSQL_ADDON_USER,
  password: E.DB_PASSWORD || E.MYSQL_ADDON_PASSWORD,
};
if (!config.host || !config.database || !config.user) {
  console.error('\nFalta configurar la base de datos. Completa DB_HOST, DB_PORT, DB_NAME, DB_USER y DB_PASSWORD en backend/.env\n');
  process.exit(1);
}
const pool = mysql.createPool({
  ...config,
  connectionLimit: Number(E.DB_POOL || 3), // el plan gratuito de Clever Cloud permite muy pocas conexiones
  waitForConnections: true,
  enableKeepAlive: true,
  charset: 'utf8mb4',
  dateStrings: true, // fechas como texto "AAAA-MM-DD HH:MM:SS"
  decimalNumbers: true,
  timezone: 'Z',
});
// Todas las fechas se guardan en hora universal (UTC).
pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

type Param = string | number | boolean | null | undefined | bigint;
/** Fila genérica devuelta por la base de datos. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;
const clean = (p: Param[]) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
const tx = new AsyncLocalStorage<PoolConnection>();
async function exec(sql: string, p: Param[]) {
  const [result] = await (tx.getStore() ?? pool).query(sql, clean(p));
  return result;
}
export const q = {
  /** Primera fila o undefined. */
  get: async (sql: string, ...p: Param[]): Promise<Row | undefined> => ((await exec(sql, p)) as Row[])[0],
  /** Todas las filas. */
  all: async (sql: string, ...p: Param[]): Promise<Row[]> => (await exec(sql, p)) as Row[],
  /** INSERT / UPDATE / DELETE. */
  run: async (sql: string, ...p: Param[]): Promise<{ lastInsertRowid: number; changes: number }> => {
    const r = (await exec(sql, p)) as ResultSetHeader;
    return { lastInsertRowid: r.insertId, changes: r.affectedRows };
  },
  /** Ejecuta varias operaciones como una sola: si una falla, se deshacen todas. */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const r = await tx.run(conn, fn);
      await conn.commit();
      return r;
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  },
};

try {
  await pool.query('SELECT 1');
  const nube = /clever-?cloud/i.test(config.host) ? ' (Clever Cloud)' : '';
  console.log(`\n  ✔ Conectado a la base de datos MySQL${nube}`);
  console.log(`    Base: ${config.database}  ·  Servidor: ${config.host}:${config.port}\n`);
} catch (e) {
  console.error(`\n  ✖ No se pudo conectar a MySQL en ${config.host}:${config.port} (${(e as Error).message}).\n    Revisa los datos DB_* en backend/.env\n`);
  process.exit(1);
}

const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const NOW = 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(150) NOT NULL UNIQUE, password_hash VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'estudiante', phone VARCHAR(30), reset_token VARCHAR(64), reset_expires BIGINT, created_at ${NOW}) ${T}`,
  `CREATE TABLE IF NOT EXISTS categories (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, slug VARCHAR(80) NOT NULL UNIQUE, icon VARCHAR(20) DEFAULT 'libro') ${T}`,
  `CREATE TABLE IF NOT EXISTS courses (
    id INT AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(90) NOT NULL UNIQUE, title VARCHAR(120) NOT NULL, short_desc VARCHAR(200) DEFAULT '', description TEXT,
    instructor VARCHAR(100) DEFAULT '', instructor_title VARCHAR(100) DEFAULT '', category_id INT NULL,
    level VARCHAR(40) DEFAULT 'Principiante', language VARCHAR(40) DEFAULT 'Español', duration_hours DOUBLE DEFAULT 0,
    price DOUBLE NOT NULL DEFAULT 0, old_price DOUBLE NULL, image VARCHAR(300), requirements TEXT, learn TEXT, includes TEXT,
    published TINYINT NOT NULL DEFAULT 0, has_certificate TINYINT NOT NULL DEFAULT 1, is_demo TINYINT NOT NULL DEFAULT 0, created_at ${NOW},
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL) ${T}`,
  `CREATE TABLE IF NOT EXISTS modules (id INT AUTO_INCREMENT PRIMARY KEY, course_id INT NOT NULL, title VARCHAR(150) NOT NULL, position INT NOT NULL DEFAULT 0,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE) ${T}`,
  `CREATE TABLE IF NOT EXISTS lessons (
    id INT AUTO_INCREMENT PRIMARY KEY, module_id INT NOT NULL, course_id INT NOT NULL,
    title VARCHAR(150) NOT NULL, type VARCHAR(20) NOT NULL DEFAULT 'video', video_kind VARCHAR(20), video_url VARCHAR(500), content MEDIUMTEXT,
    duration_min INT DEFAULT 0, is_free TINYINT NOT NULL DEFAULT 0, position INT NOT NULL DEFAULT 0, pass_percent INT NOT NULL DEFAULT 70, resources TEXT,
    FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE, FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE) ${T}`,
  `CREATE TABLE IF NOT EXISTS questions (id INT AUTO_INCREMENT PRIMARY KEY, lesson_id INT NOT NULL, text VARCHAR(500) NOT NULL, options TEXT NOT NULL, correct_index INT NOT NULL, position INT NOT NULL DEFAULT 0,
    FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE) ${T}`,
  `CREATE TABLE IF NOT EXISTS quiz_attempts (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, lesson_id INT NOT NULL, correct INT NOT NULL, total INT NOT NULL, passed TINYINT NOT NULL, created_at ${NOW},
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE) ${T}`,
  `CREATE TABLE IF NOT EXISTS coupons (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE, percent INT NOT NULL, active TINYINT NOT NULL DEFAULT 1) ${T}`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(20) NOT NULL UNIQUE, user_id INT NOT NULL, course_id INT NOT NULL,
    price DOUBLE NOT NULL, discount DOUBLE NOT NULL DEFAULT 0, total DOUBLE NOT NULL, coupon_code VARCHAR(40), method VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pendiente', operation_ref VARCHAR(60), voucher VARCHAR(200), note VARCHAR(300), created_at ${NOW}, updated_at ${NOW},
    FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (course_id) REFERENCES courses(id)) ${T}`,
  `CREATE TABLE IF NOT EXISTS enrollments (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, course_id INT NOT NULL, last_lesson_id INT, created_at ${NOW},
    UNIQUE KEY uq_enrollment (user_id, course_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (course_id) REFERENCES courses(id)) ${T}`,
  `CREATE TABLE IF NOT EXISTS progress (user_id INT NOT NULL, lesson_id INT NOT NULL, status VARCHAR(20) NOT NULL, updated_at ${NOW}, PRIMARY KEY (user_id, lesson_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE) ${T}`,
  `CREATE TABLE IF NOT EXISTS qa (id INT AUTO_INCREMENT PRIMARY KEY, course_id INT NOT NULL, lesson_id INT NOT NULL, user_id INT NOT NULL, question TEXT NOT NULL, answer TEXT, answered_by VARCHAR(100), created_at ${NOW}, answered_at DATETIME NULL,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE, FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ${T}`,
  `CREATE TABLE IF NOT EXISTS reviews (id INT AUTO_INCREMENT PRIMARY KEY, course_id INT NOT NULL, user_id INT NOT NULL, rating INT NOT NULL, comment TEXT, hidden TINYINT NOT NULL DEFAULT 0, created_at ${NOW},
    UNIQUE KEY uq_review (course_id, user_id), FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE) ${T}`,
  `CREATE TABLE IF NOT EXISTS certificates (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(20) NOT NULL UNIQUE, user_id INT NOT NULL, course_id INT NOT NULL, student_name VARCHAR(100) NOT NULL, revoked TINYINT NOT NULL DEFAULT 0, issued_at ${NOW},
    UNIQUE KEY uq_certificate (user_id, course_id), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (course_id) REFERENCES courses(id)) ${T}`,
  `CREATE TABLE IF NOT EXISTS messages (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(150) NOT NULL, message TEXT NOT NULL, created_at ${NOW}) ${T}`,
];
for (const sql of SCHEMA) await pool.query(sql);

export const slugify = (s: string): string =>
  String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'curso';

// ---------- Datos de demostración (solo la primera vez) ----------
if (!(await q.get('SELECT id FROM users LIMIT 1'))) {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@aulapro.pe';
  const adminPass = process.env.ADMIN_PASSWORD || 'Admin123!';
  (await q.run("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')", 'Administrador', adminEmail, bcrypt.hashSync(adminPass, 10)));
  const demoStudents: number[] = [];
  for (const [i, n] of ['Estudiante Demo Uno', 'Estudiante Demo Dos'].entries())
    demoStudents.push((await q.run('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)', n, `demo${i + 1}@aulapro.pe`, bcrypt.hashSync('Demo1234!', 10))).lastInsertRowid);
  (await q.run("INSERT INTO coupons (code,percent) VALUES ('DEMO100',100),('BIENVENIDA20',20)"));

  const cats: Record<string, number> = {};
  for (const [name, icon] of [['Marketing', 'maletin'], ['Tecnología', 'codigo'], ['Negocios', 'personas'], ['Desarrollo personal', 'birrete']])
    cats[name] = (await q.run('INSERT INTO categories (name,slug,icon) VALUES (?,?,?)', name, slugify(name), icon)).lastInsertRowid;

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
  for (const [i, [title, cat, level, hours, price, old, inst, instT, short, temario, preguntas]] of demo.entries()) {
    const slug = slugify(title);
    const cid = (await q.run(
      `INSERT INTO courses (slug,title,short_desc,description,instructor,instructor_title,category_id,level,duration_hours,price,old_price,image,requirements,learn,includes,published,is_demo,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,DATE_SUB(NOW(), INTERVAL ? DAY))`,
      slug, title, short,
      `${short}\n\nEste es un curso de demostración para que conozcas cómo funciona la plataforma. Desde el panel de administración puedes editarlo, reemplazar sus lecciones y videos, o eliminarlo.`,
      inst, instT, cats[cat], level, hours, price, old, `/img/curso-${i + 1}.svg`,
      JSON.stringify(['Computadora o celular con internet', 'Ganas de aprender y practicar']),
      JSON.stringify(temario.map(([m]) => `Dominar: ${m.toLowerCase()}`).concat('Aplicar lo aprendido en un caso práctico')),
      JSON.stringify(['Acceso de por vida', 'Lecciones en video y lectura', 'Examen final', 'Certificado verificable con código QR']),
      i)).lastInsertRowid;
    let first = true;
    for (const [mi, [mt, ls]] of temario.entries()) {
      const mid = (await q.run('INSERT INTO modules (course_id,title,position) VALUES (?,?,?)', cid, `Tema ${mi + 1}: ${mt}`, mi)).lastInsertRowid;
      for (const [li, lt] of ls.entries()) {
        await q.run("INSERT INTO lessons (module_id,course_id,title,type,content,duration_min,is_free,position,resources) VALUES (?,?,?,?,?,?,?,?,'[]')",
          mid, cid, lt, li === 0 ? 'video' : 'texto',
          `Lección de demostración: «${lt}».\n\nAquí aparecerá el contenido que el administrador escriba para esta lección: explicaciones, pasos, enlaces y materiales descargables.`,
          10 + li * 5, first, li);
        first = false;
      }
    }
    const mid = (await q.run('INSERT INTO modules (course_id,title,position) VALUES (?,?,?)', cid, 'Examen', 99)).lastInsertRowid;
    const lid = (await q.run("INSERT INTO lessons (module_id,course_id,title,type,content,duration_min,position,pass_percent,resources) VALUES (?,?,?,'cuestionario',?,15,0,70,'[]')",
      mid, cid, 'Examen final', 'Responde las preguntas para completar el curso.')).lastInsertRowid;
    for (const [pi, [t, o, c]] of preguntas.entries()) await q.run('INSERT INTO questions (lesson_id,text,options,correct_index,position) VALUES (?,?,?,?,?)', lid, t, JSON.stringify(o), c, pi);
    if (i < 3) for (const [k, uid] of demoStudents.entries()) {
      await q.run('INSERT INTO enrollments (user_id,course_id) VALUES (?,?)', uid, cid);
      await q.run('INSERT INTO reviews (course_id,user_id,rating,comment) VALUES (?,?,?,?)', cid, uid, 5 - ((i + k) % 2),
        k ? 'Reseña de demostración: contenido claro y fácil de seguir.' : 'Reseña de demostración: pude aplicar lo aprendido desde la primera semana.');
    }
  }
  console.log(`\n  Datos de demostración creados.\n  Administrador: ${adminEmail} / ${adminPass}  (cambia la contraseña al ingresar)\n  Estudiante demo: demo1@aulapro.pe / Demo1234!\n`);
}
