#!/usr/bin/env node
// Conformidad EN VIVO del buzón de correo que emite `build`.
//
// Hermano de broker-check.js, con el mismo razonamiento detrás. El arnés consulta
// el buzón por HTTP con rutas, parámetros de búsqueda y nombres de campo que salen
// de `src/lib/mail-probes.js`, y nada de eso se ejecuta en `npm test`: la suite
// compara cadenas y `compile-check` compila, pero entre «compila» y «un escenario
// del pipeline lo prueba» no hay ninguna red. Un `query=` que la imagen no acepta,
// un campo que se llama `Subject` y no `subject`, una búsqueda que devuelve el
// resumen donde el Then espera el cuerpo: todo eso pasa los `includes(...)` y solo
// se ve contra un Mailpit de verdad, al precio de una corrida entera.
//
// **No arranca la aplicación**, a propósito y por la misma razón que broker-check:
// el `main` recién generado no compila (build deja TODOs para el agente). Lo que sí
// es 100 % de `build` es la lectura del buzón, y es exactamente donde vive el fallo.
// Para ejercitarla sin la app, el runner habla SMTP crudo por un socket: son cinco
// líneas de protocolo y evita añadir una dependencia al paquete.
//
// Los comandos y las rutas NO se escriben aquí: salen de `src/lib/mail-probes.js`,
// el mismo módulo del que el arnés renderiza su Java y del que el catálogo saca su
// sondeo y su purga. Un runner con rutas propias comprobaría que Mailpit responde,
// no que el generador acierta.
//
//   node packages/keel-spring/scripts/mail-check.js [fixture] [--keep]
//   npm run mail-check --workspace packages/keel-spring
//
// Salidas: 0 todo OK · 1 hay fallos · 2 la infraestructura no levantó (sin veredicto).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { tmpDir } from '../test/helpers/tmp.js';
import {
  HTTP_PORT,
  SMTP_PORT,
  SEARCH_PREFIX,
  SEARCH_LIMIT,
  searchSuffix,
  ROUTES,
  FIELDS
} from '../src/lib/mail-probes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'notification-mailer';
const keep = args.includes('--keep');

const API = `http://localhost:${HTTP_PORT}/api/v1`;

// ─── Procesos y compose (misma resolución que los scripts generados) ─────────

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function resolveRuntime() {
  const preferred = process.env.CONTAINER_RUNTIME;
  for (const runtime of preferred ? [preferred] : ['docker', 'podman']) {
    if (run(runtime, ['--version']).status !== 0) continue;
    const frontends =
      runtime === 'podman'
        ? [
            { command: 'podman', prefix: ['compose'] },
            { command: 'podman-compose', prefix: [] }
          ]
        : [{ command: 'docker', prefix: ['compose'] }];
    return { runtime, frontends };
  }
  return null;
}

function composeUp(frontends, projectDir) {
  const failures = [];
  for (const frontend of frontends) {
    const result = run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'up', '-d', 'mailpit'], {
      cwd: projectDir
    });
    if (result.status === 0) return { frontend, log: result.stdout + result.stderr };
    failures.push(`${frontend.command}: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`);
  }
  return { frontend: null, log: failures.join('\n') };
}

function composeDown(frontend, projectDir) {
  run(frontend.command, [...frontend.prefix, '-f', 'infra/docker-compose.yaml', 'down', '-v'], { cwd: projectDir });
}

// ─── SMTP crudo ──────────────────────────────────────────────────────────────
//
// Lo mínimo para que Mailpit acepte un mensaje: sin AUTH ni STARTTLS, que es como
// lo configura el fragmento `local`. Si esto dejara de funcionar, lo que estaría
// mal es la configuración del contenedor, no el runner — y ese también es un
// resultado útil.

function sendMail({ from, to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const boundary = 'keelcheck0000';
    const body = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      html,
      `--${boundary}--`,
      ''
    ].join('\r\n');

    const script = [
      'EHLO keel-check',
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      `${body}\r\n.`,
      'QUIT'
    ];

    const socket = net.createConnection({ host: 'localhost', port: SMTP_PORT });
    socket.setEncoding('utf8');
    socket.setTimeout(15000);
    let step = -1; // -1 = esperando el saludo del servidor
    let log = '';

    socket.on('data', (chunk) => {
      log += chunk;
      // El servidor puede mandar varias líneas por respuesta; solo la última sin
      // guion tras el código la cierra. Sin esta comprobación, el EHLO multilínea
      // haría avanzar el guion cuatro veces y el diálogo se desincronizaría.
      if (!/^\d{3} [^\n]*\r?\n$/m.test(chunk.split(/\r?\n/).filter(Boolean).slice(-1)[0] + '\n')) {
        const last = chunk.trimEnd().split(/\r?\n/).pop();
        if (/^\d{3}-/.test(last)) return;
      }
      step += 1;
      if (step >= script.length) return;
      socket.write(`${script[step]}\r\n`);
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`SMTP sin respuesta en 15 s. Diálogo:\n${log}`));
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(log));
  });
}

// ─── La API, por las MISMAS rutas que renderiza el arnés ─────────────────────

async function api(pathname) {
  const response = await fetch(API + pathname);
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${pathname}: ${await response.text()}`);
  return response.json();
}

async function search(address, limit) {
  return api(SEARCH_PREFIX + encodeURIComponent(`to:${address}`) + searchSuffix(limit));
}

/**
 * Lee un campo por la MISMA ruta que el arnés pasa a JsonPath, sin traerse la
 * librería. El comodín tiene que seguir aplicando los segmentos que van detrás
 * (`$.messages[*].ID` son los ids, no los mensajes): un lector que se pare en el
 * comodín devuelve objetos donde se esperaban cadenas, y los escenarios que solo
 * miran la longitud pasan igual — es decir, el error se esconde justo donde más
 * daño hace.
 */
function read(json, jsonPath) {
  const segments = jsonPath.replace(/^\$\.?/, '').split('.');
  let current = json;
  for (let i = 0; i < segments.length; i += 1) {
    if (current == null) return undefined;
    const segment = segments[i];
    if (segment.endsWith('[*]')) {
      const items = current[segment.slice(0, -3)] ?? [];
      const rest = segments.slice(i + 1);
      return rest.length === 0 ? [...items] : items.map((item) => read(item, rest.join('.')));
    }
    const indexed = segment.match(/^(\w+)\[(\d+)\]$/);
    current = indexed ? (current[indexed[1]] ?? [])[Number(indexed[2])] : current[segment];
  }
  return current;
}

async function purge() {
  const response = await fetch(API + ROUTES.messages(), { method: 'DELETE' });
  if (!response.ok) throw new Error(`No se pudo purgar el buzón: HTTP ${response.status}`);
}

async function waitForApi() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      await api(ROUTES.info());
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

// ─── Escenarios ──────────────────────────────────────────────────────────────
//
// Cada uno ataca una clase de fallo que ningún test de cadenas puede ver.

// Lo que rompe al pasar por SMTP y por una URL: acentos, comillas y un signo que
// hay que codificar en el término de búsqueda.
const TRICKY_SUBJECT = 'Tu pedido A-1042 está confirmado — "gracias"';
const TRICKY_HTML = '<h1>Gracias por tu compra, Ana</h1><p>Total: 89,90 €</p>';
const TRICKY_TEXT = 'Gracias por tu compra, Ana.\r\nTotal: 89,90 €';
const ADDRESS = 'cliente+etiqueta@ejemplo.com';
const VOLUME_ADDRESS = 'volumen@ejemplo.com';
const OTHER_ADDRESS = 'otro@ejemplo.com';
const SENDER = 'pedidos@tutienda.com';

async function scenarios() {
  const results = [];
  const check = async (id, title, fn) => {
    try {
      await fn();
      results.push({ id, title, ok: true, detail: '' });
      console.log(`  OK   ${id} ${title}`);
    } catch (error) {
      results.push({ id, title, ok: false, detail: error.message });
      console.log(`  KO   ${id} ${title} — ${error.message}`);
    }
  };

  await check('MAIL-1', 'la API responde y el buzón arranca vacío', async () => {
    await purge();
    const found = await search(ADDRESS);
    const ids = read(found, FIELDS.searchIds) ?? [];
    if (ids.length !== 0) throw new Error(`el buzón no está vacío tras purgar: ${ids.length} mensaje(s)`);
  });

  await check('MAIL-2', 'un mensaje entregado por SMTP aparece en la búsqueda por destinatario', async () => {
    await sendMail({ from: SENDER, to: ADDRESS, subject: TRICKY_SUBJECT, html: TRICKY_HTML, text: TRICKY_TEXT });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ids = read(await search(ADDRESS), FIELDS.searchIds) ?? [];
      if (ids.length === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('el mensaje no apareció en 10 s: la búsqueda del arnés no lo encontraría');
  });

  // La razón de ser de la segunda llamada del arnés: el listado NO trae el cuerpo.
  // Si esto fallara, todo Then sobre el contenido del correo estaría afirmando
  // sobre un resumen, y pasaría en verde con el correo equivocado.
  await check('MAIL-3', 'el detalle trae el asunto y las DOS partes del cuerpo, byte a byte', async () => {
    const ids = read(await search(ADDRESS), FIELDS.searchIds);
    const message = await api(ROUTES.message(ids[0]));
    const subject = read(message, FIELDS.subject);
    if (subject !== TRICKY_SUBJECT) throw new Error(`asunto alterado: ${JSON.stringify(subject)}`);
    const html = read(message, FIELDS.html) ?? '';
    if (!html.includes('89,90 €')) throw new Error(`el HTML no vuelve intacto: ${JSON.stringify(html.slice(0, 80))}`);
    const text = read(message, FIELDS.text) ?? '';
    if (!text.includes('89,90 €')) throw new Error(`la parte de texto no vuelve intacta: ${JSON.stringify(text.slice(0, 80))}`);
    if (html === text) throw new Error('HTML y texto llegan iguales: el multipart/alternative no se separó');
  });

  await check('MAIL-4', 'el remitente se lee por la ruta que usa el arnés', async () => {
    const ids = read(await search(ADDRESS), FIELDS.searchIds);
    const message = await api(ROUTES.message(ids[0]));
    const from = read(message, FIELDS.from);
    if (from !== SENDER) throw new Error(`remitente esperado ${SENDER}, leído ${JSON.stringify(from)}`);
  });

  // El Then de «no se duplicó». Sin esto, un segundo envío que la búsqueda no
  // contara dejaría pasar en verde el escenario de idempotencia sin probar nada.
  await check('MAIL-5', 'dos envíos al mismo destinatario se cuentan como dos', async () => {
    await sendMail({ from: SENDER, to: ADDRESS, subject: 'Segundo', html: '<p>2</p>', text: '2' });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ids = read(await search(ADDRESS), FIELDS.searchIds) ?? [];
      if (ids.length === 2) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('la búsqueda no cuenta dos: el escenario de idempotencia no distinguiría uno de dos correos');
  });

  // El filtro tiene que discriminar de verdad. Un `search` que ignorase el término
  // devolvería el buzón entero y `assertNoMailTo` fallaría siempre — o peor, un
  // filtro demasiado laxo lo haría pasar siempre.
  await check('MAIL-6', 'la búsqueda discrimina por destinatario', async () => {
    const otros = read(await search('nadie@ejemplo.com'), FIELDS.searchIds) ?? [];
    if (otros.length !== 0) throw new Error(`la búsqueda devuelve ${otros.length} mensaje(s) de otro destinatario`);
  });

  // El techo de la búsqueda. `limit` recorta la LISTA de mensajes, y el arnés cuenta
  // por esa lista: sin mirar el conteo real, `mailCount` satura en el límite y
  // `awaitMailTo` no se puede satisfacer por encima de él por muchos correos que
  // entregue el servidor. Pasó tal cual en una corrida real, con un escenario de
  // volumen fallando con un conteo plano que ningún fix de aplicación podía superar.
  //
  // Se comprueba el MECANISMO con un límite explícito pequeño, no con 200 sockets: lo
  // que puede estar mal es la aritmética (leer el total y volver a pedir con él) y el
  // campo del que sale ese total, no la cifra concreta del techo.
  await check('MAIL-8', 'el conteo de la búsqueda es el de los que CASAN, no el del buzón entero', async () => {
    await purge();
    for (let i = 1; i <= 3; i += 1) {
      await sendMail({ from: SENDER, to: VOLUME_ADDRESS, subject: `Volumen ${i}`, html: `<p>${i}</p>`, text: `${i}` });
    }
    for (let i = 1; i <= 2; i += 1) {
      await sendMail({ from: SENDER, to: OTHER_ADDRESS, subject: `Otro ${i}`, html: `<p>${i}</p>`, text: `${i}` });
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const found = await search(VOLUME_ADDRESS);
      if ((read(found, FIELDS.searchIds) ?? []).length === 3) {
        const total = read(found, FIELDS.searchTotal);
        if (total !== 3) {
          throw new Error(
            `${FIELDS.searchTotal} vale ${JSON.stringify(total)} con 3 mensajes que casan y 5 en el buzón: ` +
              'no es el conteo de la búsqueda, así que repaginar con él pediría de más o de menos'
          );
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('no llegaron los 3 mensajes de volumen en 10 s');
  });

  await check('MAIL-9', 'por encima del límite, el total permite repaginar y recuperarlos todos', async () => {
    const recortada = await search(VOLUME_ADDRESS, 2);
    const ids = read(recortada, FIELDS.searchIds) ?? [];
    if (ids.length !== 2) {
      throw new Error(`limit=2 devolvió ${ids.length} ids: el parámetro que el arnés emite no recorta la lista`);
    }
    const total = read(recortada, FIELDS.searchTotal);
    if (total !== 3) throw new Error(`el total de una respuesta recortada vale ${JSON.stringify(total)}, no 3`);
    // Exactamente lo que hace mailIdsTo cuando el total supera su techo.
    const completa = await search(VOLUME_ADDRESS, total);
    const todos = read(completa, FIELDS.searchIds) ?? [];
    if (todos.length !== 3) {
      throw new Error(`repaginar con limit=${total} devolvió ${todos.length} ids: el techo sigue ahí`);
    }
    if (SEARCH_LIMIT < 200) {
      throw new Error(`SEARCH_LIMIT=${SEARCH_LIMIT}: el techo por defecto quedó por debajo de una tanda de despacho`);
    }
  });

  await check('MAIL-7', 'la purga deja el buzón vacío entre flujos', async () => {
    await purge();
    const ids = read(await search(ADDRESS), FIELDS.searchIds) ?? [];
    if (ids.length !== 0) throw new Error(`quedan ${ids.length} mensaje(s) tras purgar: un flujo leería los del anterior`);
  });

  return results;
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(path.join(fixturesDir, fixture, 'service.keel.yaml'))) {
  console.error(`No existe la fixture '${fixture}' en ${fixturesDir}`);
  process.exit(2);
}

const service = loadService(path.join(fixturesDir, fixture));
if (service.errors.length > 0) {
  console.error(`La fixture '${fixture}' no carga: ${service.errors.join(' | ')}`);
  process.exit(2);
}
if (!service.layers.mail) {
  console.error(`La fixture '${fixture}' no declara capa mail: no hay buzón que comprobar.`);
  process.exit(2);
}

const runtimeInfo = resolveRuntime();
if (!runtimeInfo) {
  console.error('No hay docker ni podman utilizable en el PATH. Este check los necesita; el resto de la suite no.');
  process.exit(2);
}

const workspace = tmpDir('keel-mail-check-');
let frontend = null;
let projectDir = null;
let results = [];
let fatal = null;

try {
  scaffoldService({ manifest: service.manifest, layers: service.layers, workspace, force: true });
  const projectName = fs
    .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
    .find((entry) => entry.isDirectory()).name;
  projectDir = path.join(workspace, 'services', projectName);

  process.stdout.write('levantando el buzón… ');
  const up = composeUp(runtimeInfo.frontends, projectDir);
  if (!up.frontend) {
    console.error(`\nno levanta:\n${up.log}`);
    process.exit(2);
  }
  frontend = up.frontend;
  console.log(`OK (${up.frontend.command})`);

  if (!(await waitForApi())) {
    console.error(`La API no respondió en 60 s en ${API}.`);
    fatal = 'la API del buzón no arrancó';
  } else {
    results = await scenarios();
  }
} finally {
  if (frontend && projectDir && !keep) composeDown(frontend, projectDir);
  if (keep && projectDir) console.log(`  (--keep) proyecto en ${projectDir}`);
}

console.log('\nMatriz de escenarios');
for (const result of results) console.log(`  ${result.id}  ${result.ok ? 'OK' : 'KO'}  ${result.title}`);

fs.writeFileSync(
  path.join(process.cwd(), 'mail-check.json'),
  JSON.stringify({ fixture, results, fatal }, null, 2),
  'utf8'
);

if (fatal) process.exit(2);
process.exit(results.some((result) => !result.ok) ? 1 : 0);
