// El delta entre lo que la PUERTA DE DISEÑO dice y lo que el GENERADOR descubre al
// traducir. Este archivo existe para que ese delta no vuelva a crecer en silencio.
//
// El problema que mide. Un diseño puede pasar `keel validate` en verde y aun así hacer
// que el generador avise media docena de veces al traducirlo a código. Cada uno de esos
// avisos es una decisión que el diseño no tomó y que alguien tomará más tarde: el
// generador eligiendo un default, o el agente improvisando dentro del proyecto. Cuando se
// midió por primera vez, las once fixtures producían 15 avisos de traducción con el
// diseño en verde, y **doce de los quince se decidían mirando solo el YAML**.
//
// El caso que lo resume: seis de once fixtures exponían un `POST` sin declarar su
// `successStatus`, así que el generador elegía 201 o 200 según cómo empezara el nombre de
// la operación. Eso es contrato público —lo ve un integrador, lo afirma un escenario—
// decidido por una heurística sobre un nombre. Y la asimetría que lo delataba: el aviso
// del `DELETE` sin `successStatus` llevaba años en `crossrefs.js`; el del POST no existía.
//
// Cómo funciona esto. No compara cadenas: clasifica cada aviso del generador en una
// FAMILIA, y cada familia dice una de dos cosas —qué comprobación del diseño la anticipa
// (`anticipa`), o por qué no puede anticiparla nadie (`soloGenerador`, con su motivo
// escrito)—. Un aviso que no case con ninguna familia pone el test en rojo: es la señal de
// que el generador aprendió a decir algo nuevo sobre el diseño y nadie decidió dónde va.
//
// Es el patrón de `capability-coverage.test.js`: no prohíbe los huecos, los inventaría, y
// lo que impide es que aparezca uno NUEVO sin que nadie lo mire.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadService, validateService } from 'keel-core';
import { planService } from '../src/scaffold/index.js';
import { checkSupportedFeatures } from '../src/lib/supported-features.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Las familias de aviso que el generador emite al traducir un diseño.
 *
 * - `match` — reconoce el aviso. Se busca un fragmento estable del mensaje, no el mensaje
 *   entero: lo que se clasifica es la familia, y retocar una frase no debe romper esto.
 * - `anticipa` — el id de la comprobación de diseño que dice lo mismo ANTES. El test
 *   exige que, en toda fixture donde el generador avise, la validación traiga ese id.
 * - `soloGenerador` — por qué esta familia no puede vivir en la puerta de diseño. Una
 *   familia sin una cosa o la otra no compila: esa es la disciplina.
 */
const FAMILIAS = [
  {
    nombre: 'POST sin successStatus',
    match: 'endpoint POST sin successStatus',
    anticipa: 'CHK-API-POST-NO-STATUS'
  },
  {
    nombre: 'entidad hija fuera del input',
    match: 'no entra en el input',
    anticipa: 'CHK-USECASES-CHILD-NOT-IN-INPUT'
  },
  {
    nombre: 'mismo code con status distintos',
    match: 'se declara con status distinto',
    anticipa: 'CHK-USECASES-CODE-MULTI-STATUS'
  },
  {
    nombre: 'auditoría sobre entidad anidada',
    match: "la política 'all' se aplica a las raíces de agregado",
    anticipa: 'CHK-PERSIST-AUDIT-NESTED'
  },
  {
    nombre: 'barrido que build no puede reclamar',
    match: 'build NO puede generarlo',
    soloGenerador:
      'la forma del reclamo depende del modelo que construye el generador (qué estados quedan en vuelo y qué ' +
      'reloj los mide). El DSL declara el lifecycle, no el reclamo, y ahí es donde la frontera tiene que estar: ' +
      'el diseño es legítimo y lo que falta es código que escribe el agente'
  }
];

function fixtureNames() {
  return fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Lo que el generador dice sobre el diseño, en sus DOS orígenes, que no son lo mismo:
 *
 * - `frontera` — `supported-features.js`: «el DSL declara X y yo genero Y en su lugar».
 *   Es la frontera DECLARADA de este generador, y por construcción no la puede anticipar
 *   la puerta de diseño: la respuesta depende de qué generador uses, y keel-core no sabe
 *   que Spring existe. Se clasifica entera por su origen y no por el texto de cada aviso;
 *   clasificarlos uno a uno daría a entender que alguno podría subir al diseño.
 * - `modelo` — los avisos que salen de traducir el diseño a código. Estos sí pueden ser
 *   del diseño, y son los que este archivo reparte familia a familia.
 */
function avisosDelGenerador(dir) {
  const { manifest, layers } = loadService(dir);
  const features = checkSupportedFeatures(manifest, layers);
  const { model } = planService({ manifest, layers, workspace: dir, stack: null });
  return { frontera: features.warnings, modelo: model.warnings, manifest, layers };
}

test('todo aviso del generador sobre el diseño pertenece a una familia clasificada', () => {
  const sinClasificar = [];
  for (const name of fixtureNames()) {
    const { modelo: avisos } = avisosDelGenerador(path.join(fixturesDir, name));
    for (const aviso of avisos) {
      if (FAMILIAS.some((familia) => aviso.includes(familia.match))) continue;
      sinClasificar.push(`${name}: ${aviso.slice(0, 140)}`);
    }
  }
  assert.deepEqual(
    sinClasificar,
    [],
    'el generador dice algo sobre el diseño que ninguna familia reconoce. Clasifícalo en FAMILIAS: o lo ' +
      'anticipa una comprobación del diseño (y se añade con su id), o hay que escribir por qué no puede ' +
      'anticiparlo nadie. Lo que no vale es dejarlo sin decidir:\n' +
      sinClasificar.join('\n')
  );
});

test('lo que el generador dice y el diseño puede saber, lo dice el diseño primero', () => {
  const huecos = [];
  for (const name of fixtureNames()) {
    const dir = path.join(fixturesDir, name);
    const { modelo: avisos } = avisosDelGenerador(dir);
    const ids = new Set((validateService(dir, { wip: false }).findings ?? []).map((finding) => finding.id));

    for (const familia of FAMILIAS) {
      if (!familia.anticipa) continue;
      if (!avisos.some((aviso) => aviso.includes(familia.match))) continue;
      if (ids.has(familia.anticipa)) continue;
      huecos.push(`${name}: el generador avisa de «${familia.nombre}» y la validación no emite ${familia.anticipa}`);
    }
  }
  assert.deepEqual(
    huecos,
    [],
    'un aviso que el diseño puede anticipar y no anticipa es una decisión que se descubre tarde:\n' + huecos.join('\n')
  );
});

test('cada familia dice quién la contesta, o por qué nadie puede', () => {
  // La disciplina que hace que este archivo no se degrade a una lista de excepciones:
  // `soloGenerador` exige motivo escrito, igual que los `razonado` de la matriz de
  // paridad. Sin eso, la salida barata de cualquier aviso incómodo sería declararlo
  // inevitable.
  for (const familia of FAMILIAS) {
    assert.ok(familia.match?.length > 10, `${familia.nombre}: sin patrón que la reconozca`);
    assert.ok(
      Boolean(familia.anticipa) !== Boolean(familia.soloGenerador),
      `${familia.nombre}: declara exactamente una de las dos, 'anticipa' o 'soloGenerador'`
    );
    if (familia.soloGenerador) {
      assert.ok(familia.soloGenerador.length > 60, `${familia.nombre}: 'soloGenerador' sin motivo escrito`);
    }
  }
});

test('ninguna familia sobra: todas se disparan sobre alguna fixture', () => {
  // Una familia que nada dispara describe un aviso que el generador ya no emite, y
  // entonces este archivo estaría clasificando fantasmas — y peor: su `anticipa` daría
  // por cubierta una comprobación que nadie ejerce.
  const vistas = new Set();
  for (const name of fixtureNames()) {
    const { modelo: avisos } = avisosDelGenerador(path.join(fixturesDir, name));
    for (const familia of FAMILIAS) {
      if (avisos.some((aviso) => aviso.includes(familia.match))) vistas.add(familia.nombre);
    }
  }
  const muertas = FAMILIAS.filter((familia) => !vistas.has(familia.nombre)).map((familia) => familia.nombre);
  assert.deepEqual(muertas, [], 'familias que ninguna fixture dispara: o el generador dejó de decirlo, o falta la fixture');
});
