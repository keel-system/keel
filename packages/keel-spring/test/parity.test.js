// La comprobación de paridad, dirigida por la matriz.
//
// Qué caza, y por qué no lo cazaba nadie. Las redes que existen —`store-check`, `claim-check`,
// `mongo-check`— miden si un mecanismo es CORRECTO: si su predicado casa, si su lease excluye, si
// su script vuelve con el valor. Ninguna mide si el mecanismo ESTÁ. Y esa es una familia entera de
// fallos, con ocho casos contados en la cabecera de `engine-support.js`: una rama deja de emitir
// algo que la otra sí emite, no falla nada, no se loguea nada, y el escenario que debería echarlo
// de menos ni siquiera se puede escribir.
//
// El instrumento son los pares byte a byte (`job-dispatch`/`-mongo`,
// `notification-mailer`/`-mongo`): el mismo diseño con una única diferencia. Lo que este archivo
// añade sobre los tres tests de forma que ya existen —`guard-claim`, `rescue-shape-coverage`,
// `reconciliation-shape-coverage`— no es más cobertura de esos tres mecanismos, es que **un
// mecanismo nuevo no se puede añadir sin declarar cómo se ve en las DOS ramas**. Aquellos se
// escribieron uno a uno, cada vez que un hueco costó una corrida; esto llega antes.
//
// Marcadores por SUBCADENA y no por regex, a propósito: en este repo un escape mal puesto ya
// abortó un gate entero, y un gate abortado es indistinguible de uno en verde.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { loadService } from 'keel-core';
import { scaffoldService } from '../src/scaffold/index.js';
import { MECHANISMS, MODELS, PAIRS } from '../src/lib/engine-support.js';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(pkgRoot, 'test', 'fixtures');

// Solo texto: el wrapper de Gradle trae un .jar, y leerlo como utf8 no aporta nada.
const TEXTO = new Set(['.java', '.sh', '.yaml', '.yml', '.md', '.gradle', '.json', '.sql', '.properties', '.xml']);

/**
 * El árbol generado de una fixture: la lista de RUTAS y el texto, por separado.
 *
 * Separados a propósito. Un marcador `file:` pregunta si el archivo existe; uno de texto, si la
 * cadena aparece. Meterlo todo en un mismo blob confunde las dos cosas — y el primer rojo de este
 * archivo fue justo eso: el árbol documental no trae `infra/export-schema.sh`, pero siete
 * documentos suyos lo mencionan.
 */
const arboles = new Map();
function arbolDe(fixture) {
  if (arboles.has(fixture)) return arboles.get(fixture);

  const { manifest, layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, [], `${fixture} no valida`);
  const workspace = tmpDir('keel-parity-');
  const result = scaffoldService({ manifest, layers, workspace, force: true });
  const root = path.join(workspace, result.outDir);

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  const rutas = new Set();
  const partes = [];
  for (const file of walk(root)) {
    rutas.add(path.relative(root, file).split(path.sep).join('/'));
    if (TEXTO.has(path.extname(file))) partes.push(fs.readFileSync(file, 'utf8'));
  }
  const arbol = { rutas, texto: partes.join('\n'), root };
  arboles.set(fixture, arbol);
  return arbol;
}

/** La raíz del proyecto generado de una fixture, para leer un archivo concreto. */
const raizDe = (fixture) => arbolDe(fixture).root;

/** Un marcador `file:` pregunta por la RUTA; cualquier otro, por el texto. */
const trae = (arbol, marker) =>
  marker.startsWith('file:') ? arbol.rutas.has(marker.slice('file:'.length)) : arbol.texto.includes(marker);

const porModelo = Object.entries(MECHANISMS).filter(([, m]) => m.axis === 'model');

// ─── Que la tabla no se pueda rellenar a medias ──────────────────────────────

test('los pares existen y siguen siendo dos fixtures distintas', () => {
  for (const [nombre, par] of Object.entries(PAIRS)) {
    for (const modelo of MODELS) {
      const dir = path.join(fixturesDir, par[modelo]);
      assert.ok(fs.existsSync(dir), `el par '${nombre}' nombra una fixture que no existe: ${par[modelo]}`);
    }
    assert.notEqual(par.relational, par.document, `el par '${nombre}' apunta dos veces a la misma fixture`);
  }
});

for (const [id, mechanism] of porModelo) {
  test(`${id}: declara cómo se mira en las dos ramas, o por qué no`, () => {
    const parity = mechanism.parity;
    assert.ok(parity, `${id}: mecanismo del eje de modelo sin bloque parity`);

    if (parity.skip) {
      // La escotilla honesta, y con dueño: un motivo escrito y el test que lo cubre en su lugar.
      assert.ok(parity.skip.length >= 40, `${id}: skip sin motivo escrito`);
      assert.ok(parity.test, `${id}: skip sin decir quién lo cubre en su lugar`);
      assert.ok(fs.existsSync(path.join(pkgRoot, parity.test)), `${id}: ${parity.test} no existe`);
      return;
    }

    assert.ok(PAIRS[parity.pair], `${id}: el par '${parity.pair}' no está declarado`);
    assert.deepEqual(
      Object.keys(parity.markers).sort(),
      [...MODELS].sort(),
      `${id}: los marcadores no cubren los dos modelos`
    );

    // La regla que impide declarar un mecanismo bifurcado y decir solo cómo se ve en una rama —
    // que es, literalmente, la forma que tenían los ocho fallos. La única excusa para una lista
    // vacía es que esa rama no exista.
    for (const modelo of MODELS) {
      const cell = mechanism.coverage[modelo];
      if (cell.state === 'no-aplica') continue;
      assert.ok(
        (parity.markers[modelo] ?? []).length > 0,
        `${id}/${modelo}: la matriz dice que esta rama existe (${cell.state}) y no dice cómo verla`
      );
    }
  });
}

// ─── Y que lo declarado esté de verdad en el árbol ───────────────────────────

for (const [id, mechanism] of porModelo) {
  if (mechanism.parity?.skip) continue;

  for (const modelo of MODELS) {
    const cell = mechanism.coverage[modelo];
    if (cell.state === 'no-aplica') continue;

    test(`${id}/${modelo}: el árbol generado lo trae`, () => {
      const fixture = PAIRS[mechanism.parity.pair][modelo];
      const arbol = arbolDe(fixture);
      for (const marker of mechanism.parity.markers[modelo]) {
        assert.ok(
          trae(arbol, marker),
          `${id}/${modelo}: '${marker}' no aparece en ${fixture}. O la rama dejó de emitirlo —que es el ` +
            'fallo que este archivo existe para cazar— o el marcador se quedó obsoleto; lo segundo se ' +
            'arregla en engine-support.js, lo primero no'
        );
      }
    });
  }
}

// ─── Lo que el agente LEE, que también se bifurca ────────────────────────────
//
// Este caso existe porque el test de arriba encontró el defecto en su primera ejecución: el
// `AGENTS.md` de un proyecto documental emitía, palabra por palabra, el paso relacional del
// esquema — correr un `infra/export-schema.sh` que no existe, escribir un baseline en un
// `db/migration/` que no existe y contrastarlo con unas entidades `Jpa` que no existen. El bullet
// de la capa `persistence`, cincuenta líneas más arriba en el mismo archivo, sí se bifurcaba; el
// paso de verificación colgaba solo de `layersPresent.persistence`.
//
// Es la misma familia que la nota del barrido diciendo «UPDATE condicional» sobre Mongo, y merece
// caso propio por dónde vive: el contexto del proyecto es el PRIMER archivo que lee el agente, así
// que un paso equivocado ahí no es una errata, es una instrucción.
//
// Se afirma en las DOS direcciones. Solo la primera mitad la pasaría un contexto que nombrara los
// dos mecanismos «por si acaso», que es la salida fácil y la peor.

test('el contexto del proyecto manda verificar el esquema de SU modelo, no el del otro', () => {
  for (const [modelo, fixture] of Object.entries(PAIRS['notification-mailer'])) {
    const arbol = arbolDe(fixture);
    const contexto = [...arbol.rutas].filter((ruta) => ruta === 'AGENTS.md' || ruta === 'CLAUDE.md');
    assert.equal(contexto.length, 2, `${fixture}: faltan los archivos de contexto`);

    const propio = modelo === 'document' ? 'infra/export-indexes.sh' : 'infra/export-schema.sh';
    const ajeno = modelo === 'document' ? 'infra/export-schema.sh' : 'infra/export-indexes.sh';

    // El paso del pipeline vive en AGENTS.md (CLAUDE.md es su proyección).
    const agents = fs.readFileSync(path.join(raizDe(fixture), 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes(propio), `${fixture}: el contexto no manda ejecutar ${propio}`);
    assert.ok(
      !agents.includes(ajeno),
      `${fixture}: el contexto manda ejecutar ${ajeno}, que es el mecanismo del OTRO modelo — y en este ` +
        'proyecto ese archivo no existe'
    );
  }
});

// ─── La asimetría declarada es asimetría de verdad ───────────────────────────

test('lo que una rama declara como no-aplica NO aparece en la otra por accidente', () => {
  // El complemento del caso de arriba, y no es simetría por gusto: si `document-indexes` declara
  // `no-aplica` en relacional y el árbol relacional trajera un MongoIndexConfig, la matriz
  // estaría describiendo un generador que no es el que hay.
  for (const [id, mechanism] of porModelo) {
    if (mechanism.parity?.skip) continue;
    for (const modelo of MODELS) {
      if (mechanism.coverage[modelo].state !== 'no-aplica') continue;
      const otro = modelo === 'relational' ? 'document' : 'relational';
      const arbol = arbolDe(PAIRS[mechanism.parity.pair][modelo]);
      for (const marker of mechanism.parity.markers[otro] ?? []) {
        assert.ok(
          !trae(arbol, marker),
          `${id}/${modelo}: declarado 'no-aplica' y sin embargo aparece '${marker}'`
        );
      }
    }
  }
});
