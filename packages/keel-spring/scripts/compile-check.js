#!/usr/bin/env node
// Compila DE VERDAD el andamiaje que emite `build`, con javac a través de Gradle.
//
// Por qué no está en `npm test`: necesita JDK y red (Gradle resuelve las dependencias
// de Spring la primera vez), y tarda minutos. `java-syntax.test.js` cubre sin JDK las
// dos familias de error que el generador puede introducir por construir código con
// plantillas; esto cubre el resto —tipos, firmas, genéricos— y es la única verificación
// que no depende de que alguien haya acertado escribiendo una aserción.
//
// **Qué compila y qué no.** Solo el source set `integrationTest`. El `main` recién
// generado NO compila a propósito: build deja TODOs para el agente, y algunos son
// llamadas a métodos que el agente debe añadir (el projector de una réplica llama a
// `projectionOf`/`applySnapshot`, que escribe él en la entidad). Su gate es
// `./gradlew build -x test` DESPUÉS del agente de código, dentro del pipeline. El
// arnés, en cambio, es 100% de build —el source set excluye `main` de su classpath a
// propósito— y por eso sí puede exigirse verde recién generado.
//
//   node packages/keel-spring/scripts/compile-check.js [fixture] [--broker=<id>]
//   npm run compile-check --workspace packages/keel-spring

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'catalog-extended';
const brokerArg = args.find((arg) => arg.startsWith('--broker='))?.split('=')[1];
// Los tres brokers tienen ramas distintas de `deliverMessage` en el arnés: si no se
// pide uno concreto, se comprueban todos. Es donde más barato sale un fallo de tipos.
const brokers = brokerArg ? [brokerArg] : ['kafka', 'rabbitmq', 'snssqs'];

if (!fs.existsSync(path.join(fixturesDir, fixture, 'service.keel.yaml'))) {
  console.error(`No existe la fixture '${fixture}' en ${fixturesDir}`);
  process.exit(2);
}

const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
if (java.error) {
  console.error('No hay JDK en el PATH. Este check lo necesita; el resto de la suite no.');
  process.exit(2);
}

let failed = 0;
for (const broker of brokers) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `keel-compile-${broker}-`));
  try {
    const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
    if (errors.length > 0) {
      console.error(`${fixture}: la fixture no carga:\n  ${errors.join('\n  ')}`);
      process.exit(2);
    }
    scaffoldService({ manifest, layers, workspace, force: true, stack: { broker } });

    const project = fs
      .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
      .find((entry) => entry.isDirectory());
    const projectDir = path.join(workspace, 'services', project.name);

    process.stdout.write(`${fixture} (${broker}): compilando el arnés… `);
    // El wrapper vendorizado se invoca por `sh` para que valga igual en Windows.
    const result = spawnSync('sh', ['gradlew', 'compileIntegrationTestJava', '--console=plain', '--no-daemon'], {
      cwd: projectDir,
      encoding: 'utf8'
    });
    if (result.status === 0) {
      console.log('OK');
    } else {
      failed++;
      console.log('FALLA');
      console.error(result.stdout ?? '');
      console.error(result.stderr ?? '');
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

process.exit(failed > 0 ? 1 : 0);
