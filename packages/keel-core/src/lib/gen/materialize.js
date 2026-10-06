// Escribir un proyecto generado sin pisar el trabajo de nadie (keel-core/gen).
//
// NEUTRAL: dado el árbol que un generador renderizó EN MEMORIA y el registro de lo que escribió
// la última vez (generated-manifest.js), decide qué se escribe, qué se deja al lado como
// conflicto, qué se poda y cómo queda el registro. Es la misma decisión para cualquier
// generador, y por eso no vive en ninguno: un arreglo de esta lógica tiene que llegar a todos.

import fs from 'node:fs';
import path from 'node:path';
import { classifyGenerated, digestOf, pruneOrphans } from '../write.js';
import { writeProjectFiles } from './project-writer.js';
import { readManifest, nextManifest, writeManifest, designStamp, REFRESH_DIR } from './generated-manifest.js';

const posixOf = (entry) => entry.path.split(/[\\/]/).join('/');

/**
 * Escribe `files` en `projectDir` según el modo:
 *   - sin modo: lo que no existe (o todo con `force`), nunca lo que alguien BORRÓ;
 *   - `refresh`: lo nuevo y lo que es del generador y nadie tocó; la versión nueva de un
 *     conflicto va a REFRESH_DIR; con `prune`, retira los huérfanos intactos;
 *   - `check`: no escribe nada.
 * `generator` es la firma que queda en el manifiesto (`keel-spring@0.1.6`).
 */
export function materializeProject({
  files,
  projectDir,
  generator,
  force = false,
  mode = null,
  prune = false,
  readiness = null,
  acceptedUnready = false
}) {
  // Clasificar ANTES de escribir: es lo que separa «este archivo es mío y me he
  // quedado atrás» de «este lo escribió el agente». Con el booleano `force` a solas
  // las dos cosas se ven igual, y por eso un arreglo del generador no podía llegar a un
  // proyecto que ya existe sin destruir trabajo.
  const previous = readManifest(projectDir);
  const buckets = classifyGenerated(files, projectDir, previous);
  const alDia = new Set(buckets.alDia);
  const alDiaDigests = files.filter((entry) => alDia.has(posixOf(entry))).map((entry) => [posixOf(entry), digestOf(entry)]);

  // Qué se escribe en esta pasada, por modo. `check` no escribe nada; `refresh` pone
  // al día lo que es de build y nadie tocó; sin modo, el comportamiento de siempre.
  let only = null;
  if (mode === 'check') only = new Set();
  else if (mode === 'refresh') only = new Set([...buckets.nuevos, ...buckets.refrescables]);

  // Lo que alguien borró NO vuelve, en ningún modo. En `refresh` ya queda fuera por no
  // estar en `only`; sin modo hace falta decirlo, porque ahí la regla es «escribe lo que
  // no exista» y un archivo borrado es, justamente, uno que no existe.
  const { copied, skipped, digests } = writeProjectFiles(files, projectDir, {
    force,
    only,
    skip: new Set(buckets.retirados)
  });

  // Los huérfanos que se puede demostrar que son de build (nadie los tocó) se retiran
  // con --prune; los tocados se quedan y pasan al agente vía EVOLUTION.md.
  const pruned = mode === 'refresh' && prune ? pruneOrphans(buckets.huerfanos, projectDir, previous) : null;

  // Un huérfano que ya NO está en disco no es trabajo de nadie: lo retiró el agente, o un
  // `--prune` anterior. Se olvida en cualquier pasada de escritura, no solo con --prune;
  // si no, el manifiesto lo arrastra para siempre y `--check` lo reporta como «el generador
  // ya no lo emite (no se borran)» sobre un archivo que no existe.
  const huerfanosVivos = buckets.huerfanos.filter((relative) => fs.existsSync(path.join(projectDir, relative)));
  const huerfanosAusentes = buckets.huerfanos.filter((relative) => !fs.existsSync(path.join(projectDir, relative)));

  // La versión nueva de lo que está en conflicto, para poder compararla con diff. Es
  // exactamente el trabajo que si no hay que hacer a mano: generar el proyecto en otro
  // sitio solo para ver qué cambió el generador en ESE archivo. Entran también las
  // fusiones que siguen pendientes de una pasada anterior: si alguien limpió `build/`,
  // su versión nueva se vuelve a dejar donde EVOLUTION.md dice que está.
  const enConflicto = new Set([...buckets.conflictos, ...Object.keys(previous?.pendingMerge ?? {})]);
  if (mode === 'refresh' && enConflicto.size > 0) {
    writeProjectFiles(
      files.filter((entry) => enConflicto.has(posixOf(entry))),
      path.join(projectDir, REFRESH_DIR),
      { force: true }
    );
  }

  // Los stubs que build acaba de crear y traen trabajo para el agente.
  const nuevos = new Set(buckets.nuevos);
  const escritos = new Set(copied);
  const nuevosConTodo = files
    .filter((entry) => nuevos.has(posixOf(entry)) && escritos.has(posixOf(entry)))
    .filter((entry) => typeof entry.content === 'string' && entry.content.includes('TODO'))
    .map(posixOf)
    .sort((a, b) => a.localeCompare(b));

  // El manifiesto se actualiza incluso en `check`, donde `digests` viene vacío: lo que
  // hace ahí es ADOPTAR lo que ya estaba, que es lo que da el aviso a los proyectos
  // anteriores al mecanismo sin tocarles un solo archivo.
  let pendingMerge = Object.keys(previous?.pendingMerge ?? {});
  if (mode !== 'check') {
    const digestByPath = new Map(files.map((entry) => [posixOf(entry), entry]));
    const next = nextManifest({
      previous,
      // Solo en --refresh: es cuando la versión nueva del conflicto se ha dejado en
      // REFRESH_DIR y la fusión pasa a ser trabajo de alguien con nombre.
      rebase:
        mode === 'refresh' ? buckets.conflictos.map((relative) => [relative, digestOf(digestByPath.get(relative))]) : [],
      olvidar: [...(pruned ? [...pruned.borrados, ...pruned.ausentes] : []), ...huerfanosAusentes],
      resueltos: buckets.alDia,
      generator,
      design: designStamp(readiness, { acceptedUnready }),
      // Lo escrito en esta pasada, MÁS lo que ya era byte a byte idéntico a lo que el
      // generador emite. Eso último importa para los proyectos que existían antes del
      // mecanismo: adoptarlo TODO los dejaba sin poder refrescar nunca —cada archivo
      // quedaba para siempre «sin registro»—, cuando ser idéntico a la salida del
      // generador es la prueba más fuerte que puede haber de que es suya. Lo que de
      // verdad no se puede atribuir es solo lo que ya difiere.
      escritas: [...digests, ...alDiaDigests],
      presentes: [...buckets.adoptados, ...buckets.refrescables, ...buckets.tuyos, ...buckets.conflictos]
    });
    writeManifest(projectDir, next);
    pendingMerge = Object.keys(next.pendingMerge);
  }

  return {
    copied,
    skipped,
    buckets,
    huerfanosVivos,
    pruned,
    pendingMerge: pendingMerge.sort((a, b) => a.localeCompare(b)),
    nuevosConTodo
  };
}
