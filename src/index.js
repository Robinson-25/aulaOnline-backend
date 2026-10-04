// Punto de entrada: revisa la versión de Node antes de cargar la aplicación.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`\nEsta plataforma necesita Node.js 22.18 o superior (tienes ${process.versions.node}).`);
  console.error('Descarga la versión LTS más reciente en https://nodejs.org\n');
  process.exit(1);
}
await import('./app.ts');
