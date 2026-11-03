// La comprobación de paridad ENTRE RAMAS, dirigida por la matriz: el gemelo de los de keel-spring, keel-nest y keel-dotnet.
//
// Las redes en vivo miden si un mecanismo es CORRECTO; ninguna mide si ESTÁ. Una rama que deja de emitir algo que la otra sí
// emite no falla nada. El instrumento son los pares byte a byte de keel-core (`job-dispatch`/`-mongo`,
// `notification-mailer`/`-mongo`). Un marcador puede acotarse a un archivo:
//   · `file:<ruta>`        el archivo existe;
//   · `<ruta>::<texto>`    el texto aparece EN ESE archivo;
//   · `<texto>`            el texto aparece en algún archivo del árbol.

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

const arboles = new Map();
function arbolDe(fixture) {
  if (arboles.has(fixture)) return arboles.get(fixture);
  const { manifest, layers, errors } = loadService(path.join(FIXTURES_DIR, fixture));
  assert.deepEqual(errors, [], `${fixture} no carga`);
  const { files } = planService({ manifest, layers, workspace: FIXTURES_DIR });
  const arbol = { archivos: new Map(files.map((file) => [file.path, file.content])), texto: files.map((file) => file.content).join('\n') };
  arboles.set(fixture, arbol);
  return arbol;
}

function trae(arbol, marker) {
  if (marker.startsWith('file:')) return arbol.archivos.has(marker.slice('file:'.length));
  const scoped = marker.indexOf('::');
  if (scoped > 0) return (arbol.archivos.get(marker.slice(0, scoped)) ?? '').includes(marker.slice(scoped + 2));
  return arbol.texto.includes(marker);
}

const porModelo = Object.entries(MECHANISMS).filter(([id]) => MECHANISM_CATALOG[id].axis === 'model');

for (const [id, mechanism] of porModelo) {
  test(`${id}: declara cómo se mira en las dos ramas, o por qué no`, () => {
    const { parity } = mechanism;
    assert.ok(parity, `${id}: mecanismo del eje de modelo sin bloque parity`);
    if (parity.skip) {
      assert.ok(parity.skip.length >= 40, `${id}: skip sin motivo escrito`);
      assert.ok(parity.test && fs.existsSync(path.join(pkgRoot, parity.test)), `${id}: ${parity.test} no existe`);
      return;
    }
    assert.ok(PAIRS[parity.pair], `${id}: el par '${parity.pair}' no está declarado`);
    assert.deepEqual(Object.keys(parity.markers).sort(), [...MODELS].sort(), `${id}: los marcadores no cubren los dos modelos`);
    for (const modelo of MODELS) {
      if (mechanism.coverage[modelo].state === 'no-aplica') continue;
      assert.ok(parity.markers[modelo].length > 0, `${id}/${modelo}: la matriz dice que esta rama existe y no dice cómo verla`);
    }
  });

  if (mechanism.parity?.skip) continue;
  for (const modelo of MODELS) {
    if (mechanism.coverage[modelo].state === 'no-aplica') continue;
    test(`${id}/${modelo}: el árbol generado lo trae`, () => {
      const fixture = PAIRS[mechanism.parity.pair][modelo];
      for (const marker of mechanism.parity.markers[modelo]) {
        assert.ok(trae(arbolDe(fixture), marker), `${id}/${modelo}: '${marker}' no aparece en ${fixture}: o la rama dejó de emitirlo o el marcador se quedó obsoleto`);
      }
    });
  }
}

test('lo que una rama declara como no-aplica NO aparece en ella por accidente', () => {
  for (const [id, mechanism] of porModelo) {
    if (mechanism.parity?.skip) continue;
    for (const modelo of MODELS) {
      if (mechanism.coverage[modelo].state !== 'no-aplica') continue;
      const otro = modelo === 'relational' ? 'document' : 'relational';
      const arbol = arbolDe(PAIRS[mechanism.parity.pair][modelo]);
      for (const marker of mechanism.parity.markers[otro]) assert.ok(!trae(arbol, marker), `${id}/${modelo}: declarado 'no-aplica' y aparece '${marker}'`);
    }
  }
});

test('el contexto del proyecto manda verificar el esquema de SU modelo, no el del otro', () => {
  const { relational, document } = PAIRS['notification-mailer'];
  const documental = arbolDe(document);
  assert.ok(documental.archivos.has('infra/export-indexes.sh'));
  assert.ok(!arbolDe(relational).archivos.has('infra/export-indexes.sh'), 'el relacional emite el script del otro modelo');
});

test('un marcador acotado mira solo su archivo', () => {
  const arbol = { archivos: new Map([['A.go', 'FindOneAndUpdate('], ['B.go', 'SKIP LOCKED']]), texto: 'FindOneAndUpdate(\nSKIP LOCKED' };
  assert.ok(trae(arbol, 'A.go::FindOneAndUpdate('));
  assert.ok(!trae(arbol, 'B.go::FindOneAndUpdate('));
  assert.ok(trae(arbol, 'file:B.go') && !trae(arbol, 'file:C.go'));
});
