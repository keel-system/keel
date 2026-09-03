#!/usr/bin/env node
// Compila DE VERDAD el andamiaje que emite `build`, con javac a través de Gradle.
//
// Por qué no está en `npm test`: necesita JDK y red (Gradle resuelve las dependencias
// de Spring la primera vez), y tarda minutos. `java-syntax.test.js` cubre sin JDK las
// dos familias de error que el generador puede introducir por construir código con
// plantillas; esto cubre el resto —tipos, firmas, genéricos— y es la única verificación
// que no depende de que alguien haya acertado escribiendo una aserción.
//
// **Qué compila y qué no.** Siempre el source set `integrationTest`, que es 100% de build
// —su classpath excluye `main` a propósito— y por eso puede exigirse verde recién generado.
// Y TAMBIÉN el `main`, salvo donde el propio diseño dice que no puede: lo decide
// `mainCompilable()` (src/lib/main-compilable.js) leyendo las capas.
//
// Que el `main` quedara fuera venía de dar por hecho que los TODOs lo impiden, y no es
// cierto: un stub que termina en `throw new UnsupportedOperationException(...)` compila. Lo
// que lo impide es código generado que LLAMA a un método del agente, y hoy eso es solo la
// réplica (el projector invoca `projectionOf`/`applySnapshot`). Mientras tanto, TODO el
// código que solo vive en `main` —el reclamo con su JPQL y su `findAndModify`, los
// adaptadores de persistencia, el relay— no lo compilaba nadie: los tests comparan cadenas y
// `java-syntax` solo tokeniza. Su otro gate sigue siendo `./gradlew build -x test` DESPUÉS
// del agente, dentro del pipeline; esto llega mucho antes y sin agente de por medio.
//
//   node packages/keel-spring/scripts/compile-check.js [fixture] [--broker=<id>]
//   npm run compile-check --workspace packages/keel-spring
//
// **Por qué el npm script invoca esto varias veces.** Cada pasada añade un eje que ninguna
// de las anteriores compila, y todas nacieron de un agujero real.
//
// El eje del MOTOR no acaba en los seis dialectos relacionales: `persistence.default.model:
// document` es otra rama entera del scaffolding —espejo, repositorios, reclamos por
// `findAndModify`, y un arnés que habla `mongosh` en vez de `psql`—, y con la fixture por
// defecto, que es relacional, no se compilaba nunca. Es el MISMO agujero que tenía el eje
// del motor antes de la pasada de MySQL, y aquel costó una corrida entera: Java inválido
// que salía verde aquí porque la combinación que lo producía no se compilaba jamás.
//
// Con un broker basta para esas pasadas: lo que cambia con el modelo de persistencia no
// cambia además con el broker, y los tres brokers ya se cruzan en la primera.
//
// Otra por la capa `mail`, que añade su propio Java al arnés (las aserciones sobre el buzón
// que emite `mail-harness.js`). Ninguna de las demás fixtures la declara, así que ese arnés
// no se había compilado nunca: `mail-check` comprueba que las rutas del buzón sean las
// correctas contra un Mailpit real, pero no que el Java que las usa compile.
//
// Y las dos últimas por el RESCATE de un barrido —las filas que otra réplica dejó en vuelo—,
// que hasta que existió `job-dispatch` no lo generaba ninguna fixture: ni el reclamo con su
// cota temporal ni los tres helpers del arnés (`stallInFlight`, `putInFlight`,
// `inFlightWithoutClock`) habían pasado nunca por javac. Van dos porque son el par
// relacional/documental del mismo diseño, y el `mongoEval` del segundo lleva sus comillas
// escapadas dentro de un literal Java: tres niveles de plantilla.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { mainCompilable } from '../src/lib/main-compilable.js';
import { scaffoldService } from '../src/scaffold/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

const args = process.argv.slice(2);
const fixture = args.find((arg) => !arg.startsWith('--')) ?? 'catalog-extended';
const brokerArg = args.find((arg) => arg.startsWith('--broker='))?.split('=')[1];
// Los tres brokers tienen ramas distintas de `deliverMessage` en el arnés: si no se
// pide uno concreto, se comprueban todos. Es donde más barato sale un fallo de tipos.
const brokers = brokerArg ? [brokerArg] : ['kafka', 'rabbitmq', 'snssqs'];
const databaseArg = args.find((arg) => arg.startsWith('--database='))?.split('=')[1];
// El proveedor de identidad es otro eje con Java propio: con `serviceAuth.validateAudience`,
// Cognito no comprueba el claim `aud` sino el PREFIJO del scope, así que su filtro de audiencia
// es otra plantilla. Se tokenizaba en java-syntax y no lo compilaba nadie.
const authArg = args.find((arg) => arg.startsWith('--auth='))?.split('=')[1];

/**
 * Qué combinaciones se compilan.
 *
 * El broker es el eje evidente —tres ramas de `deliverMessage`— pero NO es el único: el
 * arnés también tiene código que depende del MOTOR, y ese eje faltaba. Costó una corrida
 * entera descubrirlo: `uuidLiteral()` se emitía con Java inválido bajo MySQL —una llamada a
 * un método inexistente en vez de una cadena— y aquí salía verde SIEMPRE, porque sin
 * `--database` el stack cae en el default (PostgreSQL) y ahí la misma plantilla produce Java
 * válido por casualidad. El source set entero dejaba de compilar en el proyecto real.
 *
 * Así que se añade una pasada con MySQL, que es el otro motor cuyo arnés difiere. No se
 * multiplican los seis por los tres brokers: eso son minutos por combinación y el código que
 * cambia con el motor no cambia además con el broker.
 */
if (!fs.existsSync(path.join(fixturesDir, fixture, 'service.keel.yaml'))) {
  console.error(`No existe la fixture '${fixture}' en ${fixturesDir}`);
  process.exit(2);
}

// El diseño se carga una vez aquí —y no solo dentro del bucle— porque de él depende qué
// combinaciones tienen sentido.
const { layers: fixtureLayers } = loadService(path.join(fixturesDir, fixture));

// El motor del cuarto combo depende de lo que la fixture DECLARE. Con un diseño documental,
// pedir MySQL no compila «lo mismo con otro motor»: produce un híbrido que nadie generaría
// —documento sobre motor relacional—, porque un `database` explícito gana sobre el default
// que sale de `persistence.default.model`. La segunda pasada solo tiene sentido donde añade
// un motor de la MISMA familia.
const relational = (fixtureLayers?.persistence?.default?.model ?? 'relational') !== 'document';
const combos = databaseArg
  ? brokers.map((broker) => ({ broker, database: databaseArg }))
  : [
      ...brokers.map((broker) => ({ broker, database: null })),
      ...(relational ? [{ broker: brokers[0], database: 'mysql' }] : [])
    ];



const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
if (java.error) {
  console.error('No hay JDK en el PATH. Este check lo necesita; el resto de la suite no.');
  process.exit(2);
}

let failed = 0;
for (const { broker, database } of combos) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `keel-compile-${broker}-`));
  try {
    const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
    if (errors.length > 0) {
      console.error(`${fixture}: la fixture no carga:\n  ${errors.join('\n  ')}`);
      process.exit(2);
    }
    const stack = { broker, ...(database ? { database } : {}), ...(authArg ? { auth: authArg } : {}) };
    scaffoldService({ manifest, layers, workspace, force: true, stack });

    const project = fs
      .readdirSync(path.join(workspace, 'services'), { withFileTypes: true })
      .find((entry) => entry.isDirectory());
    const projectDir = path.join(workspace, 'services', project.name);

    // El `main` va en la MISMA invocación de Gradle: son dos tareas del mismo proyecto y
    // levantar la JVM otra vez costaría más que compilarlo.
    const { compilable, motivo } = mainCompilable(layers);
    const tasks = compilable ? ['compileJava', 'compileIntegrationTestJava'] : ['compileIntegrationTestJava'];
    const que = compilable ? 'el arnés y el main' : 'el arnés';
    const combo = `${broker}${database ? `, ${database}` : ''}${authArg ? ` + ${authArg}` : ''}`;
    process.stdout.write(`${fixture} (${combo}): compilando ${que}… `);
    // El wrapper vendorizado se invoca por `sh` para que valga igual en Windows.
    const result = spawnSync('sh', ['gradlew', ...tasks, '--console=plain', '--no-daemon'], {
      cwd: projectDir,
      encoding: 'utf8'
    });
    if (result.status === 0) {
      // El motivo se dice SIEMPRE, también en verde: un `main` que deja de compilarse porque
      // alguien le añadió una réplica a la fixture no se ve de otra forma — la pasada sigue
      // en OK compilando la mitad que compilaba antes.
      console.log(compilable ? 'OK' : `OK (main fuera: ${motivo})`);
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
