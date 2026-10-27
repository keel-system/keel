// La comprobación de paridad ENTRE RAMAS, dirigida por la matriz: el gemelo de keel-spring/test/parity.test.js.
//
// Las redes en vivo (db-check, doc-check, doc-harness-check) miden si un mecanismo es CORRECTO; ninguna mide si
// ESTÁ. Una rama que deja de emitir algo que la otra sí emite no falla nada, y el escenario que debería echarlo de
// menos ni siquiera se puede escribir. El instrumento son los mismos pares byte a byte que en keel-spring
// (`job-dispatch`/`-mongo`, `notification-mailer`/`-mongo`): el mismo diseño con una única diferencia. Lo que este
// archivo impone es que un mecanismo del eje de modelo no se puede declarar sin decir cómo se ve en las DOS ramas.
//
// Una diferencia con keel-spring: aquí las dos ramas comparten a propósito los NOMBRES (el mismo OutboxRelayStore,
// el mismo IdempotencyStoreImpl: la misma API sobre otro almacén), así que un nombre no distingue la rama. Por eso un
// marcador puede acotarse a un archivo:
//   · `file:<ruta>`        el archivo existe;
//   · `<ruta>::<texto>`    el texto aparece EN ESE archivo;
//   · `<texto>`            el texto aparece en algún archivo del árbol.
// Marcadores por SUBCADENA y no por regex, como en keel-spring.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from '@keel-system/keel-core';
import { MODELS, PAIRS } from '@keel-system/keel-core/gen/mechanisms';
import { planService } from '../src/scaffold/index.js';
import { MECHANISMS, MECHANISM_CATALOG } from '../src/lib/engine-support.js';
import { FIXTURES_DIR } from './helpers/workspace.js';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** El árbol emitido de una fixture (por fixture Y por stack: el panel solo sale con telemetry: otel). */
const arboles = new Map();
function arbolDe(fixture, stack = null) {
  const clave = `${fixture}::${JSON.stringify(stack ?? {})}`;
  if (arboles.has(clave)) return arboles.get(clave);
  const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, fixture));
  assert.deepEqual(errors, [], `${fixture} no carga`);
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR, stack });
  const arbol = { archivos: new Map(files.map((file) => [file.path, file.content])), texto: files.map((file) => file.content).join('\n') };
  arboles.set(clave, arbol);
  return arbol;
}

function trae(arbol, marker) {
  if (marker.startsWith('file:')) return arbol.archivos.has(marker.slice('file:'.length));
  const scoped = marker.indexOf('::');
  if (scoped > 0) return (arbol.archivos.get(marker.slice(0, scoped)) ?? '').includes(marker.slice(scoped + 2));
  return arbol.texto.includes(marker);
}

const porModelo = Object.entries(MECHANISMS).filter(([id]) => MECHANISM_CATALOG[id].axis === 'model');

// ─── Que la tabla no se pueda rellenar a medias ──────────────────────────────

test('los pares existen y siguen siendo dos fixtures distintas', () => {
  for (const [nombre, par] of Object.entries(PAIRS)) {
    for (const modelo of MODELS) assert.ok(fs.existsSync(path.join(FIXTURES_DIR, par[modelo])), `el par '${nombre}' nombra una fixture que no existe: ${par[modelo]}`);
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
      assert.ok(parity.test && fs.existsSync(path.join(pkgRoot, parity.test)), `${id}: ${parity.test} no existe`);
      return;
    }
    assert.ok(PAIRS[parity.pair], `${id}: el par '${parity.pair}' no está declarado`);
    assert.deepEqual(Object.keys(parity.markers).sort(), [...MODELS].sort(), `${id}: los marcadores no cubren los dos modelos`);
    for (const modelo of MODELS) {
      const cell = mechanism.coverage[modelo];
      if (cell.state === 'no-aplica') continue;
      assert.ok((parity.markers[modelo] ?? []).length > 0, `${id}/${modelo}: la matriz dice que esta rama existe (${cell.state}) y no dice cómo verla`);
    }
  });
}

// ─── Y que lo declarado esté de verdad en el árbol ───────────────────────────

for (const [id, mechanism] of porModelo) {
  if (mechanism.parity?.skip) continue;
  for (const modelo of MODELS) {
    if (mechanism.coverage[modelo].state === 'no-aplica') continue;
    test(`${id}/${modelo}: el árbol generado lo trae`, () => {
      const fixture = PAIRS[mechanism.parity.pair][modelo];
      const arbol = arbolDe(fixture, mechanism.parity.stack ?? null);
      for (const marker of mechanism.parity.markers[modelo]) {
        assert.ok(
          trae(arbol, marker),
          `${id}/${modelo}: '${marker}' no aparece en ${fixture}. O la rama dejó de emitirlo —el fallo que este archivo ` +
            'existe para cazar— o el marcador se quedó obsoleto; lo segundo se arregla en engine-support.js, lo primero no'
        );
      }
    });
  }
}

// ─── La asimetría declarada es asimetría de verdad ───────────────────────────

test('lo que una rama declara como no-aplica NO aparece en ella por accidente', () => {
  for (const [id, mechanism] of porModelo) {
    if (mechanism.parity?.skip) continue;
    for (const modelo of MODELS) {
      if (mechanism.coverage[modelo].state !== 'no-aplica') continue;
      const otro = modelo === 'relational' ? 'document' : 'relational';
      const arbol = arbolDe(PAIRS[mechanism.parity.pair][modelo], mechanism.parity.stack ?? null);
      for (const marker of mechanism.parity.markers[otro] ?? []) {
        assert.ok(!trae(arbol, marker), `${id}/${modelo}: declarado 'no-aplica' y sin embargo aparece '${marker}'`);
      }
    }
  }
});

test('lo que una rama declara como degradado no lo promete su árbol (absent)', () => {
  // Un degradado que el árbol desmiente —la alerta de saturación del pool en una rama que no publica la serie— es
  // peor que el hueco: una alerta sobre una serie que nadie publica no dispara nunca.
  for (const [id, mechanism] of porModelo) {
    for (const [modelo, markers] of Object.entries(mechanism.parity?.absent ?? {})) {
      assert.equal(mechanism.coverage[modelo].state, 'degradado', `${id}/${modelo}: 'absent' solo tiene sentido en una celda degradada`);
      const arbol = arbolDe(PAIRS[mechanism.parity.pair][modelo], mechanism.parity.stack ?? null);
      for (const marker of markers) assert.ok(!trae(arbol, marker), `${id}/${modelo}: degradado y sin embargo aparece '${marker}'`);
    }
  }
});

// ─── Lo que el agente LEE, que también se bifurca ────────────────────────────

test('el contexto del proyecto manda verificar el esquema de SU modelo, no el del otro', () => {
  for (const [modelo, fixture] of Object.entries(PAIRS['notification-mailer'])) {
    const arbol = arbolDe(fixture);
    const agents = arbol.archivos.get('AGENTS.md');
    assert.ok(agents, `${fixture}: falta AGENTS.md`);
    const propio = modelo === 'document' ? 'infra/export-indexes.sh' : 'infra/export-schema.sh';
    const ajeno = modelo === 'document' ? 'infra/export-schema.sh' : 'infra/export-indexes.sh';
    assert.ok(arbol.archivos.has(propio), `${fixture}: no emite ${propio}`);
    assert.ok(!arbol.archivos.has(ajeno), `${fixture}: emite ${ajeno}, que es del otro modelo`);
    assert.ok(!agents.includes(ajeno), `${fixture}: el contexto manda ejecutar ${ajeno}, que en este proyecto no existe`);
  }
});

// El comprobador se comprueba a sí mismo: un marcador acotado a un archivo no se da por bueno porque el texto esté
// en OTRO archivo, que es la confusión que haría inútil la forma acotada.
test('un marcador acotado mira solo su archivo', () => {
  const arbol = { archivos: new Map([['a.ts', 'findOneAndUpdate('], ['b.ts', 'setOnLocked']]), texto: 'findOneAndUpdate(\nsetOnLocked' };
  assert.ok(trae(arbol, 'a.ts::findOneAndUpdate('));
  assert.ok(!trae(arbol, 'b.ts::findOneAndUpdate('));
  assert.ok(trae(arbol, 'findOneAndUpdate('));
  assert.ok(trae(arbol, 'file:b.ts') && !trae(arbol, 'file:c.ts'));
});
