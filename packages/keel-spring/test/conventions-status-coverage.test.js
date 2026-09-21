// Las conventions no pueden contradecir al catálogo de errores del framework.
//
// `FRAMEWORK_ERRORS` (keel-core) es la fuente única de los `code` que pone el generador
// cuando el diseño no nombra el conflicto de un mecanismo, y de su status. Las conventions
// que el agente lee son prosa al lado, y la prosa envejece: `mapping.md` § Normalización
// ilustraba el caso con «422 VALIDATION_ERROR» cuando el canónico es 400, y el mismo 422
// estaba copiado en un comentario de `type-mapper.js`.
//
// Lo destapó la corrida de `stock-reservation` del 2026-09-20 y llegó como `designGap`: el
// agente tenía que escribir tres casos borde de constraints, encontró 422 en un sitio y 400
// en otro, y tuvo que ELEGIR. Un contrato público decidido por cuál de los dos párrafos leyó
// antes — y ninguna suite lo veía, porque las dos cifras son texto en un markdown.
//
// La comprobación es barata y mecánica: si un documento del generador escribe un status
// pegado a un `code` del catálogo, tiene que ser el del catálogo. No se le pide que los
// mencione (sería obligar a repetir el catálogo en prosa), solo que no mienta.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_ERRORS } from 'keel-core';

const generatorDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'generators',
  'spring'
);

/**
 * `code` → status canónico. Se filtra lo que no tiene `code` FIJO —`uniqueness` lo deriva de
 * la entidad—: sin ese filtro su `undefined` entra en la alternación del regex y `join` lo
 * convierte en CADENA VACÍA, así que el patrón casa con cualquier número de tres cifras y el
 * test se pone rojo sobre «FL-PRD-001». Un detector que casa con todo no distingue mejor que
 * uno que no casa con nada.
 */
const CANONICO = new Map(
  Object.values(FRAMEWORK_ERRORS)
    .filter((e) => typeof e.code === 'string' && e.code.length > 0)
    .map((e) => [e.code, e.http])
);

/** Los .md del generador (conventions, architecture, constitution, orchestration). */
function documentos(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'skills' ? [] : documentos(full);
      return entry.name.endsWith('.md') ? [full] : [];
    });
}

/**
 * Toda atribución EXPLÍCITA de un status a un `code` del catálogo, en las dos formas en que
 * se escriben de verdad: «400 VALIDATION_ERROR» y «VALIDATION_ERROR con status 400». La
 * segunda exige la palabra delante del número a propósito: sin ella, cualquier cifra que
 * pase cerca del code cuenta como atribución y el detector acusa a quien no dijo nada.
 */
function atribuciones(texto) {
  const encontradas = [];
  const codigos = [...CANONICO.keys()].join('|');
  for (const m of texto.matchAll(new RegExp(`\\b([1-5]\\d\\d)\\s+\`?(${codigos})\`?`, 'g'))) {
    encontradas.push({ status: Number(m[1]), code: m[2], cita: m[0] });
  }
  for (const m of texto.matchAll(
    new RegExp(`\`?(${codigos})\`?[^.\\n]{0,32}?\\b(?:status|http)\\b[^.\\n]{0,8}?\\b([1-5]\\d\\d)\\b`, 'gi')
  )) {
    encontradas.push({ status: Number(m[2]), code: m[1], cita: m[0] });
  }
  return encontradas;
}

test('ninguna convention atribuye a un code canónico un status que no es el suyo', () => {
  const fallos = [];
  for (const doc of documentos(generatorDir)) {
    const texto = fs.readFileSync(doc, 'utf8');
    for (const { status, code, cita } of atribuciones(texto)) {
      if (CANONICO.get(code) !== status) {
        fallos.push(`${path.relative(generatorDir, doc)}: «${cita}» — el canónico es ${CANONICO.get(code)}`);
      }
    }
  }
  assert.deepEqual(fallos, [], `\n${fallos.join('\n')}`);
});

test('AUTOCOMPROBACIÓN: el detector ve una atribución equivocada', () => {
  // Sin esto, un regex que no case nada pasa el test de arriba sobre cualquier documento —
  // que es exactamente el estado en el que el 422 vivió meses.
  const bueno = atribuciones('se rechaza con `400 VALIDATION_ERROR` y ya');
  assert.equal(bueno.length, 1, 'el detector no ve la forma «400 CODE»');
  assert.equal(bueno[0].status, 400);

  const alReves = atribuciones("lanza VALIDATION_ERROR con status 400");
  assert.equal(alReves.length, 1, 'el detector no ve la forma «CODE … 400»');
  assert.equal(alReves[0].status, 400);

  const malo = atribuciones('se rechaza con `422 VALIDATION_ERROR` y nunca llega');
  assert.equal(malo.length, 1);
  assert.notEqual(CANONICO.get(malo[0].code), malo[0].status, 'el 422 tendría que chirriar');
});
