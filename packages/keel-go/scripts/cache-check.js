#!/usr/bin/env node
// cache-check: la caché de lectura de keel-go contra un Redis y un Valkey REALES (tramo 13e). El gemelo de los cache-check
// de keel-nest y keel-dotnet.
//
//   npm run cache-check --workspace packages/keel-go [-- --cache=redis|valkey] [-- --keep] [-- --sabotage=<id>]
//
// Lo que `npm test` no ve y la prueba emitida operation_cache_test.go tampoco, porque allí el store es un mapa: que
// go-redis, con la configuración que emite build, guarde y lea en el servidor de verdad lo que la caché cree, y que una
// caché que NO CONTESTA no retenga a quien lee. Se levanta la imagen del catálogo (la misma que el compose de infra/) y
// contra ella corre scripts/probes/cache_probe_test.go, compilada dentro de catalog-extended contra su store y su caché.
//
// Mide: la entrada en el servidor con su clave (`<caché>::<clave>`), su TTL y el JSON del cable; el acierto sin volver al
// origen y byte a byte en el cable; el vaciado de una caché sin tocar las demás; la orden de infra/reset-db.sh borrando lo
// de este servicio y nada más; con el store PAUSADO (acepta y no contesta), la lectura va al origen en el plazo de sus
// órdenes; y con el store de vuelta, la caché vuelve a guardar sin reiniciar nada.
//
// `--sabotage=<id>` rompe lo emitido CONSERVANDO LA FORMA (sigue compilando) y el check tiene que salir rojo:
//   retries   el cliente reintenta (el default de go-redis): con el store sin contestar, la lectura espera un plazo por intento
//   ttl       la entrada se guarda sin caducidad
//
// Necesita Go y podman o docker; red la primera vez (las imágenes y los módulos).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { CACHES } from '@keel-system/keel-core/gen/infra-catalog';
import { cacheFlushCmd } from '@keel-system/keel-core/gen/infra-scripts';
import { run, resolveRuntime, freePort } from '../../keel-nest/scripts/lib/database-container.js';
import { planService } from '../src/scaffold/index.js';
import { FIXTURES_DIR, makeWorkspace } from '../test/helpers/workspace.js';

const keep = process.argv.includes('--keep');
const only = process.argv.find((arg) => arg.startsWith('--cache='))?.split('=')[1] ?? null;
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const SUBJECT = 'catalog-extended';
const STORE = 'internal/infrastructure/cache/store.go';
const PROBE = 'cache_probe_test.go';
const SABOTAGES = {
  retries: [STORE, 'MaxRetries:            -1,', 'MaxRetries:            3,'],
  ttl: [STORE, 's.client.Set(ctx, key, value, ttl).Err()', 's.client.Set(ctx, key, value, 0).Err()']
};
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`Sabotaje desconocido: ${sabotage}. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}
if (only && !CACHES[only]) {
  console.error(`Caché desconocida: ${only}. Las hay: ${Object.keys(CACHES).join(', ')}.`);
  process.exit(2);
}

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

function go(cwd, args) {
  const result = spawnSync('go', args, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime), runtime ?? 'instala podman (o docker) y arráncalo')) process.exit(1);

const root = makeWorkspace('keel-go-cache-check-');
const caches = only ? [only] : Object.keys(CACHES);
try {
  for (const id of caches) {
    const entry = CACHES[id];
    console.log(`\n── ${entry.label} (${entry.image})`);
    // Un proyecto por store: el diseño con esa caché en el stack, y la sonda dentro de su paquete de la caché.
    const dir = path.join(root, id);
    const { manifest, layers } = loadService(path.join(FIXTURES_DIR, SUBJECT));
    const { files, model } = planService({ manifest, layers, workspace: root, stack: { database: 'postgresql', broker: 'rabbitmq', cache: id } });
    for (const file of files) {
      const target = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    const probe = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'probes', PROBE), 'utf8');
    fs.writeFileSync(path.join(dir, path.dirname(STORE), PROBE), probe.replaceAll('__MODULE__', model.service.goModule));
    if (sabotage) {
      const [file, from, to] = SABOTAGES[sabotage];
      const target = path.join(dir, file);
      const text = fs.readFileSync(target, 'utf8');
      if (!text.includes(from)) {
        console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
        process.exit(2);
      }
      fs.writeFileSync(target, text.replace(from, to));
      console.log(`(sabotaje: ${sabotage})`);
    }
    const tidied = go(dir, ['mod', 'tidy']);
    if (!step('go mod tidy', tidied.ok, tidied.ok ? '' : tidied.output.slice(-600))) continue;
    // Se compila aparte (go test -c) y se ejecuta desde el proyecto: en Windows el antivirus denegó alguna vez el .test.exe
    // que go test enlaza en %TEMP% (lo mismo que hacen db-check y stub-check).
    const binary = path.join(dir, 'build', process.platform === 'win32' ? 'cache-probe.test.exe' : 'cache-probe.test');
    const built = go(dir, ['test', '-c', '-o', binary, `./${path.dirname(STORE)}/`]);
    if (!step('el store y la caché emitidos compilan con la sonda', built.ok, built.ok ? '' : built.output.slice(-1500))) continue;

    const port = await freePort();
    const name = `keel-go-cache-check-${id}-${process.pid}`;
    const started = run(runtime, ['run', '-d', '--name', name, '-p', `${port}:${entry.port}`, entry.image]);
    if (!step(`${entry.label} arranca`, started.status === 0, started.status === 0 ? '' : started.stderr.trim().slice(-300))) continue;
    try {
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        ready = run(runtime, ['exec', name, 'redis-cli', 'PING']).stdout.trim() === 'PONG';
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!step('responde a PING', ready)) continue;
      const tested = spawnSync(binary, ['-test.run', '^TestCacheProbe$', '-test.count', '1', '-test.v'], {
        cwd: path.join(dir, path.dirname(STORE)),
        encoding: 'utf8',
        env: {
          ...process.env,
          CACHE_CHECK_PORT: String(port),
          CACHE_CHECK_RUNTIME: runtime,
          CACHE_CHECK_CONTAINER: name,
          // La orden de infra/reset-db.sh, contra este contenedor (allí el host es el del compose).
          CACHE_CHECK_FLUSH: cacheFlushCmd(entry, model.service).replaceAll(`-h ${entry.serviceKey}`, '-h 127.0.0.1'),
          CACHE_CHECK_SERVICE: model.service.artifactId
        },
        maxBuffer: 64 * 1024 * 1024
      });
      const output = `${tested.stdout ?? ''}${tested.stderr ?? ''}`;
      const lines = output.split('\n').filter((line) => /^(OK    |FALLA )/.test(line));
      for (const line of lines) step(line.slice(6), line.startsWith('OK'));
      if (lines.length === 0) step('la sonda corre', false, output.trim().split('\n').slice(-8).join(' | '));
    } finally {
      // Por si la sonda cayó con el contenedor pausado.
      run(runtime, ['unpause', name]);
      if (!keep) run(runtime, ['rm', '-f', name]);
    }
  }
} finally {
  if (keep) {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-go-cache-kept-'));
    fs.cpSync(root, kept, { recursive: true });
    console.log(`Conservado en ${kept}`);
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\ncache-check: ${results.length}/${results.length} en verde.` : `\ncache-check: ${failed} paso(s) en rojo${sabotage ? ` (sabotaje: ${sabotage})` : ''}.`);
process.exit(failed === 0 ? 0 : 1);
