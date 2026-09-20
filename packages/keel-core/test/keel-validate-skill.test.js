// La skill `/keel-validate` y la CLI no pueden decir cosas distintas sobre quién
// comprueba qué.
//
// Este test existe por un fallo que ya ocurrió y que nadie vio durante meses. La skill
// acoplaba con la CLI por PROSA: escribía «`keel validate` ya avisa de X» dentro de un
// párrafo, y esa frase no la comprobaba nada. Cuando se inventarió, catorce de las
// comprobaciones que la checklist pedía juzgar al agente llevaban mecanizadas en
// `crossrefs.js` — entre ellas el `circuitBreaker` sin `fallback`, que el agente estaba
// volviendo a juzgar en cada validación, gastando contexto en contestar algo que ya
// venía contestado y con riesgo de contradecirlo.
//
// La regla que impone este archivo es simple: el reparto se declara en una NOTA con la
// lista de lo mecanizado, y no dentro de la prosa de cada capa. Una nota se actualiza
// de una vez y se ve entera; una frase repartida por nueve párrafos, no.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', 'assets', 'skills', 'keel-validate');
const SKILL = path.join(DIR, 'SKILL.md');
const CHECKLIST = path.join(DIR, 'references', 'review-checklist.md');

const read = () => fs.readFileSync(SKILL, 'utf8');
const readChecklist = () => fs.readFileSync(CHECKLIST, 'utf8');

/**
 * La checklist que el AGENTE recorre. Desde que la revisión pasó a ser un recorrido por
 * id, vive en `references/` y no en la skill: la skill trae el procedimiento y esto el
 * porqué de cada pregunta, que se lee por la capa que toque y no entero.
 *
 * La NOTA de cabecera queda fuera: es el único sitio donde el reparto SÍ debe estar
 * escrito, y enumera lo mecanizado. Sin este recorte, el test que prohíbe repetir lo
 * mecanizado se dispararía contra la propia nota que lo declara.
 */
function checklistSection() {
  const text = readChecklist();
  const start = text.indexOf('**Calidad por capa');
  assert.ok(start > -1, 'la checklist ya no tiene la sección de calidad por capa');
  const end = text.indexOf('## Cómo se escribe el veredicto', start);
  return text
    .slice(start, end > -1 ? end : undefined)
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('>'))
    .join('\n');
}

test('la checklist no vuelve a acoplarse con la CLI por prosa', () => {
  // Las formas con las que se escribió el acoplamiento la primera vez. No es una lista
  // de palabras prohibidas por estilo: cada una anuncia un reparto que nada comprueba.
  const acoplamientos = [
    'keel validate ya avisa',
    'keel validate` ya avisa',
    'la CLI ya marca',
    '`keel validate` ya marca',
    'ya lo da en rojo la CLI'
  ];
  const seccion = checklistSection();
  for (const frase of acoplamientos) {
    assert.ok(
      !seccion.includes(frase),
      `la checklist dice «${frase}»: eso es acoplamiento por prosa. El reparto va en la nota ` +
        `de cabecera, que se ve entera y se actualiza de una vez`
    );
  }
});

test('el reparto está declarado, y la skill manda recorrer los ids', () => {
  const checklist = readChecklist();
  assert.match(checklist, /no est[áa] aqu[íi]/i, 'la nota no dice que lo mecanizado queda fuera');
  assert.match(checklist, /keel validate/i, 'la nota no remite a la salida de la CLI');

  // Y la skill tiene que mandar RECORRER los ids y escribir el veredicto: es lo que
  // convierte la revisión en algo con cobertura en vez de en una lectura de prosa que no
  // deja rastro.
  const skill = read();
  assert.ok(skill.includes('REV-*'), 'la skill no nombra los ids de revisión');
  assert.ok(skill.includes('review.yaml'), 'la skill no manda escribir el veredicto');
});

test('la checklist existe como referencia aparte y no dentro de la skill', () => {
  // Era la única skill del workspace sin `references/`, siendo la que decide si un diseño
  // se genera: toda su guía cabía en 68 líneas que había que leer enteras cada vez.
  assert.ok(fs.existsSync(CHECKLIST), 'falta references/review-checklist.md');
  assert.ok(!read().includes('*http-clients*:'), 'la prosa por capa volvió a la skill');
});

test('la checklist no repite lo que la CLI ya comprueba', () => {
  // Muestra deliberadamente corta y literal: las comprobaciones que se mecanizaron al
  // podar la skill. Si alguna vuelve a aparecer en la prosa de una capa, el agente la
  // juzgará dos veces. No se deriva de CHECKS a propósito — el catálogo guarda ids y
  // títulos, y lo que hay que buscar aquí es la forma en que la skill lo escribía.
  const repetidas = [
    'circuitBreaker` sin `fallback`',
    'llamadas sin `timeoutMs`',
    'subscriptions sin `onFailure`',
    'buckets sin `maxSizeMb`',
    'sin `declaredVariables`',
    '`html` sin `text`',
    'roles con permisos que ninguna regla usa',
    'mutaciones con `level: public`'
  ];
  const seccion = checklistSection();
  for (const frase of repetidas) {
    assert.ok(
      !seccion.includes(frase),
      `la checklist vuelve a pedir «${frase}», que la CLI ya comprueba con su id`
    );
  }
});
