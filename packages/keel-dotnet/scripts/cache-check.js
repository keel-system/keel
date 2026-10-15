#!/usr/bin/env node
// cache-check: la caché de lectura de keel-dotnet contra un Redis y un Valkey REALES (incremento 13f). El gemelo del
// cache-check de keel-nest.
//
//   npm run cache-check --workspace packages/keel-dotnet [-- --cache=redis|valkey] [-- --keep] [-- --sabotage=<id>]
//
// Lo que `npm test` no ve y la prueba emitida OperationCacheTests tampoco, porque allí el store es un diccionario: que
// StackExchange.Redis, con la configuración que emite build, guarde y lea en el servidor de verdad lo que el adaptador
// cree, y que una caché CAÍDA no retenga a quien lee. Se levanta la imagen del catálogo (la misma que el compose de
// infra/) y contra ella corre scripts/probes/CacheProbes, compilada contra el store y el adaptador de catalog-extended.
//
// Mide: la entrada en el servidor con su clave (`<caché>::<clave>`), su TTL y el JSON del cable; el acierto sin volver al
// origen y byte a byte en el cable; el vaciado de una caché sin tocar las demás; la orden de infra/reset-db.sh borrando lo
// de este servicio y nada más; con el store parado, la lectura va al origen en el acto; y con el store de vuelta, la
// caché vuelve a guardar sin reiniciar nada.
//
// `--sabotage=<id>` rompe lo emitido CONSERVANDO LA FORMA (sigue compilando) y el check tiene que salir rojo:
//   offline   el cliente encola las órdenes sin conexión (el default de la rama 3.x): la lectura espera al plazo
//   ttl       la entrada se guarda sin caducidad
//
// Necesita el SDK de .NET 10 y podman o docker; red la primera vez (las imágenes y NuGet).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CACHES } from 'keel-core/gen/infra-catalog';
import { cacheFlushCmd } from 'keel-core/gen/infra-scripts';
import { run, resolveRuntime, freePort } from '../../keel-nest/scripts/lib/database-container.js';
import { planFixture, makeWorkspace } from '../test/helpers/workspace.js';

const keep = process.argv.includes('--keep');
const only = process.argv.find((arg) => arg.startsWith('--cache='))?.split('=')[1] ?? null;
const sabotage = process.argv.find((arg) => arg.startsWith('--sabotage='))?.split('=')[1] ?? null;
const SUBJECT = 'catalog-extended';
const STORE = 'src/Catalog.Infrastructure/Cache/RedisCacheStore.cs';
const SABOTAGES = {
  offline: [STORE, 'BacklogPolicy = BacklogPolicy.FailFast,', 'BacklogPolicy = BacklogPolicy.Default,'],
  ttl: [STORE, 'await (await Database()).StringSetAsync(key, value, ttl);', 'await (await Database()).StringSetAsync(key, value);']
};
if (sabotage && !SABOTAGES[sabotage]) {
  console.error(`Sabotaje desconocido: ${sabotage}. Los hay: ${Object.keys(SABOTAGES).join(', ')}.`);
  process.exit(2);
}

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

function dotnet(cwd, args, env = {}) {
  const result = spawnSync('dotnet', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...env },
    maxBuffer: 64 * 1024 * 1024
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const runtime = resolveRuntime();
if (!step('podman o docker disponible', Boolean(runtime), runtime ?? 'instala podman (o docker) y arráncalo')) process.exit(1);

const root = makeWorkspace('keel-dotnet-cache-check-');
const caches = only ? [only] : Object.keys(CACHES);
try {
  for (const id of caches) {
    const entry = CACHES[id];
    console.log(`\n── ${entry.label} (${entry.image})`);
    // Una solución por store: el proyecto con esa caché en el stack, y la sonda.
    const dir = path.join(root, id);
    const { files, model } = await planFixture(SUBJECT, { stack: { database: 'postgresql', broker: 'rabbitmq', cache: id } });
    for (const file of files) {
      const target = path.join(dir, 'catalog-extended', file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    for (const shared of ['global.json', 'Directory.Build.props', 'Directory.Packages.props']) {
      fs.copyFileSync(path.join(dir, 'catalog-extended', shared), path.join(dir, shared));
    }
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'probes', 'CacheProbes'), path.join(dir, 'CacheProbes'), { recursive: true });
    if (sabotage) {
      const [file, from, to] = SABOTAGES[sabotage];
      const target = path.join(dir, 'catalog-extended', file);
      const text = fs.readFileSync(target, 'utf8');
      if (!text.includes(from)) {
        console.error(`El sabotaje '${sabotage}' no se aplica a lo emitido hoy (¿cambió el texto?).`);
        process.exit(2);
      }
      fs.writeFileSync(target, text.replace(from, to));
      console.log(`(sabotaje: ${sabotage})`);
    }
    const built = dotnet(dir, ['build', 'CacheProbes/CacheProbes.csproj', '-c', 'Release']);
    if (!step('el store y el adaptador emitidos compilan con la sonda', built.ok)) {
      console.error([...new Set(built.output.split('\n').filter((line) => /(error|warning) [A-Za-z]+\d+/.test(line)))].slice(0, 30).join('\n'));
      continue;
    }

    const port = await freePort();
    const name = `keel-dotnet-cache-check-${id}-${process.pid}`;
    const started = run(runtime, ['run', '-d', '--name', name, '-p', `${port}:${entry.port}`, entry.image]);
    if (!step(`${entry.label} arranca`, started.status === 0, started.status === 0 ? '' : started.stderr.trim().slice(-300))) continue;
    try {
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        ready = run(runtime, ['exec', name, 'redis-cli', 'PING']).stdout.trim() === 'PONG';
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!step('responde a PING', ready)) continue;
      const probe = dotnet(dir, ['run', '--project', 'CacheProbes/CacheProbes.csproj', '-c', 'Release', '--no-build'], {
        CACHE_CHECK_PORT: String(port),
        CACHE_CHECK_RUNTIME: runtime,
        CACHE_CHECK_CONTAINER: name,
        // La orden de infra/reset-db.sh, contra este contenedor (allí el host es el del compose).
        CACHE_CHECK_FLUSH: cacheFlushCmd(entry, model.service).replaceAll(`-h ${entry.serviceKey}`, '-h 127.0.0.1'),
        CACHE_CHECK_SERVICE: model.service.artifactId
      });
      const lines = probe.output.split('\n').filter((line) => /^(OK   |FALLA) /.test(line));
      for (const line of lines) step(line.slice(6), line.startsWith('OK'));
      if (lines.length === 0) step('la sonda corre', false, probe.output.trim().split('\n').slice(-5).join(' | '));
    } finally {
      if (!keep) run(runtime, ['rm', '-f', name]);
    }
  }
} finally {
  if (keep) {
    const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-dotnet-cache-kept-'));
    fs.cpSync(root, kept, { recursive: true });
    console.log(`Conservado en ${kept}`);
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `\ncache-check: ${results.length}/${results.length} en verde.` : `\ncache-check: ${failed} paso(s) en rojo${sabotage ? ` (sabotaje: ${sabotage})` : ''}.`);
process.exit(failed === 0 ? 0 : 1);
