// Qué fixtures puede compilar `compile-check` enteras, y por qué las demás no.
//
// La regla la deriva `mainCompilable()` del diseño, y no es una lista escrita a mano a
// propósito: perder la compilación del `main` no se ve. La pasada sigue saliendo en OK
// compilando la mitad de antes, y el reclamo —que solo vive en `main`— vuelve a quedarse sin
// que lo mire nadie, que es de donde venimos.
//
// Este test es lo que ata la regla a la realidad: afirma el veredicto fixture a fixture. Si
// alguien le añade una réplica a `job-dispatch`, aquí sale rojo en segundos en vez de
// silenciarse en una pasada opt-in que tarda minutos y que casi nadie ejecuta.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService } from 'keel-core';
import { mainCompilable } from '../src/lib/main-compilable.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const layersOf = (fixture) => {
  const { layers, errors } = loadService(path.join(fixturesDir, fixture));
  assert.deepEqual(errors, [], `la fixture ${fixture} no carga`);
  return layers;
};

// Verificado con javac una por una: las ocho compilan el `main` recién generado, sin agente
// de por medio. Entre ellas están las DOS ramas del reclamo (relacional y documental), la
// guarda del correo y el reclamo de la reconciliación, que hasta ahora no los compilaba nadie.
const COMPILAN = [
  'asset-vault',
  'inspection-reports',
  'job-dispatch',
  'job-dispatch-mongo',
  'metering-digest',
  'notification-mailer',
  'notification-mailer-mongo',
  'product-catalog',
  'stock-reservation'
];

for (const fixture of COMPILAN) {
  test(`${fixture}: el main compila recién generado`, () => {
    const { compilable, motivo } = mainCompilable(layersOf(fixture));
    assert.equal(compilable, true, `${fixture} dejó de ser compilable: ${motivo}`);
    assert.equal(motivo, null);
  });
}

test('catalog-extended: la réplica deja el main sin compilar, y el motivo lo dice', () => {
  // El único caso conocido, y confirmado con javac: `SupplierPriceProjector` llama a
  // `projectionOf(...)` y `applySnapshot(...)`, que el dominio no trae porque no tiene
  // setters y la política de proyección es del agente. javac dice `cannot find symbol`.
  const { compilable, motivo } = mainCompilable(layersOf('catalog-extended'));
  assert.equal(compilable, false);
  assert.match(motivo, /réplica/);
  assert.match(motivo, /projectionOf/);
  assert.match(motivo, /applySnapshot/);
  // Y nombra cuál, porque con varias el mensaje tiene que decir por dónde empezar.
  assert.match(motivo, /pricing[.]supplierPrice → SupplierPrice/);
});

test('un diseño sin capa dependencies compila: la regla no supone que la capa exista', () => {
  assert.deepEqual(mainCompilable({}), { compilable: true, motivo: null });
  assert.deepEqual(mainCompilable({ dependencies: { dependencies: {} } }), { compilable: true, motivo: null });
});

test('una dependencia replicada SIN entidad de réplica no descalifica: sin entidad no hay projector', () => {
  // La descalificación es del PROJECTOR, no de la palabra `replicated`. Pedir menos —mirar
  // solo la estrategia— dejaría fuera de javac a diseños que compilan perfectamente.
  const layers = {
    dependencies: { dependencies: { pricing: { needs: { rate: { strategy: 'replicated' } } } } }
  };
  assert.equal(mainCompilable(layers).compilable, true);
});

test('las fixtures del reparto son todas las que hay: ninguna se queda sin veredicto', () => {
  // Sin esto, una fixture nueva no entraría en ninguna de las dos listas y su veredicto no lo
  // afirmaría nadie — que es exactamente la forma de perder cobertura sin que salga rojo.
  const enDisco = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual([...COMPILAN, 'catalog-extended'].sort(), enDisco);
});
