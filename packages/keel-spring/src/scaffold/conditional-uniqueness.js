// El contrato de ORDEN que impone un índice único condicionado, y la pieza con la que se cumple.
//
// Un índice único parcial sostiene un invariante que el diseño declara —«como máximo una fila por
// esta clave mientras esté en este estado»— y en PostgreSQL se comprueba **por fila y sin poder
// diferirse**: `DEFERRABLE` es de constraints, y una constraint única PARCIAL no existe. Eso tiene
// una consecuencia que no se ve leyendo el índice, solo ejecutándolo.
//
// La operación que **releva** —retira la fila que ocupaba el estado y pone otra en su lugar, en el
// mismo acto— hace dos escrituras sobre la misma clave. Con JPA las dos son entidades gestionadas
// y sus UPDATE se vuelcan al commit, en el orden que decide Hibernate. Si el que ACTIVA se vuelca
// antes que el que RETIRA, hay un instante con dos filas en el estado condicionado y la escritura
// se rechaza: la transición legítima muere con el error de unicidad del diseño.
//
// Medido el 2026-09-07 sobre la corrida `mail-rabbit`: con el índice de verdad en vigor,
// `publishTemplate` responde 409 y caen tres escenarios de plantilla. No se había visto antes
// porque el índice llevaba el predicado en minúsculas y no indexaba ninguna fila — o sea que el
// invariante llevaba meses sin sostenerse y el defecto de orden, tapado debajo.
//
// El reparto es el de siempre: **build genera el mecanismo, el agente escribe la llamada, el gate
// verifica que exista**. Sin la primera parte, el camino de menor resistencia del agente sería
// bajarse a JPA desde `application` —que la constitución prohíbe— o, peor, quitar el índice.
//
// La rama documental no lo necesita: cada `save` es su propia escritura, así que el orden del
// código ES el orden en la base. Por eso nada de esto se emite ahí, y por eso la corrida
// `notification-mailer-mongo` pasó en verde con el mismo diseño.
//
// Y el índice puede estar sobre una HIJA del agregado (la versión de una plantilla, en prueba-gelsa):
// la hija no tiene puerto ni finder propios, así que el `flushPendingWrites()` va en el puerto de su
// RAÍZ —el flush vuelca el contexto entero, la colección de la raíz incluida— y la ocupante se busca
// con los finders de la raíz, como en keel-nest. Antes la nota del handler nombraba un puerto
// `<Hija>Repository` que no existe y el agente escribía el método a mano en el de la raíz.

import { partialUniqueIndexes } from './persistence-members.js';
import { relievingOperations as neutralRelieving } from '@keel-system/keel-core/gen/relational';
import { occupantFinders } from './repositories.js';

/** Las entidades cuyo diseño declara al menos una unicidad condicionada. */
export function conditionedEntities(model) {
  if (model.persistenceKind === 'document') return [];
  return model.entities.filter((entity) => entity.persisted && partialUniqueIndexes(entity).length > 0);
}

/** La raíz del agregado de una entidad: el dueño del puerto. Una raíz es su propia raíz. */
export function rootOf(model, entity) {
  return model.entities.find((candidate) => candidate.name === entity.rootEntity) ?? entity;
}

/** Las RAÍCES cuyo agregado lleva una unicidad condicionada, en ella o en una hija: las que tienen el flush. */
export function conditionedRoots(model) {
  return [...new Set(conditionedEntities(model).map((entity) => rootOf(model, entity)))];
}

/** Los estados condicionados del agregado de una raíz, tal como el diseño los nombra. */
const conditionedStates = (model, root) =>
  new Set(
    conditionedEntities(model)
      .filter((entity) => rootOf(model, entity) === root)
      .flatMap((entity) => partialUniqueIndexes(entity).map((index) => index.when.equals))
  );

/**
 * Las operaciones que RELEVAN: en el mismo acto sacan una fila del estado condicionado y meten
 * otra. Es la única forma que produce el choque — una operación que solo ocupa (o solo vacía) hace
 * una escritura sobre esa clave y no hay orden que forzar.
 *
 * Se deriva del DSL entero: `transitions` ya declara las dos mitades, y el diseño de
 * `notification-mailer` las escribe juntas a propósito («La versión que estaba activa se retira en
 * el mismo acto»).
 */
export function relievingOperations(model) {
  // La detección es del diseño (keel-core/gen/relational.js) y la comparte keel-nest; la rama
  // documental no la sufre (cada save es su propia escritura) y no recibe nada.
  if (conditionedEntities(model).length === 0) return [];
  return neutralRelieving(model).map((relieving) => ({
    ...relieving,
    root: rootOf(model, relieving.entity),
    method: portMethodName(relieving.entity)
  }));
}

export const portMethodName = () => 'flushPendingWrites';

/** El método del puerto `<E>Repository`, solo para las entidades que lo necesitan. */
export function portMethods(model, entity) {
  if (!conditionedRoots(model).includes(entity)) return [];
  const states = [...conditionedStates(model, entity)].join(', ');
  return [
    `    /**
     * Hace llegar a la base las escrituras pendientes de este agregado, aquí y no al commit.
     *
     * <p>Existe por el índice único condicionado sobre ${states}: se comprueba por FILA y no se
     * puede diferir, así que una operación que RELEVA —retira la fila que ocupaba ese estado y
     * pone otra— tiene que confirmar la salida ANTES de la entrada. Con JPA las dos escrituras
     * son entidades gestionadas y su UPDATE se vuelca al commit en el orden que decide Hibernate:
     * si el que activa sale primero, hay un instante con dos filas en el estado condicionado y la
     * transición LEGÍTIMA muere con el error de unicidad.
     *
     * <p>Se llama entre las dos escrituras, nunca al final: al final no ordena nada.
     */
    void ${portMethodName(entity)}();`
  ];
}

/** Su implementación en el adaptador JPA. */
export function adapterMethods(model, entity, jpaRepositoryField) {
  if (!conditionedRoots(model).includes(entity)) return [];
  return [
    `    @Override
    public void ${portMethodName(entity)}() {
        // flush() y no un save() más: lo que hace falta no es escribir otra cosa, es que lo ya
        // escrito llegue a la base en este punto. El orden lo pone quien llama.
        ${jpaRepositoryField}.flush();
    }`
  ];
}

/**
 * La nota del stub de la operación que releva. Es lo que el agente lee mientras escribe el
 * handler, y sin ella el código correcto y el roto se parecen demasiado: los dos hacen
 * `save(retirada)` y `save(nueva)` en ese orden, y solo uno funciona.
 */
export function stubNote(model, operation) {
  const relieving = relievingOperations(model).filter((r) => r.operation.name === operation.name);
  if (relieving.length === 0) return null;

  // El finder se resuelve aquí y no al detectar: la detección corre también sobre modelos
  // sintéticos sin campos, y el finder necesita los miembros del agregado. Es el de la RAÍZ: una
  // hija no tiene puerto, y su ocupante se encuentra cargando la raíz y mirando su colección.
  const occupantOf = (r) =>
    r.root === r.entity ? (occupantFinders(model, r.root).find((finder) => finder.state === r.state)?.name ?? null) : null;
  return relieving
    .map((r) => ({ ...r, occupant: occupantOf(r) }))
    .map(
      (r) =>
        `ORDEN OBLIGATORIO (índice único condicionado sobre ${r.entity.name}.${r.state}): esta operación RELEVA — ` +
        `saca una fila de '${r.state}' y mete otra en el mismo acto—, y el índice se comprueba por FILA y no se ` +
        `puede diferir. Retira la que estaba${r.occupant ? ` (la encuentras con ${r.root.name}Repository.${r.occupant}(...))` : r.root !== r.entity ? ` (está en la colección de ${r.root.name}: carga la raíz y búscala ahí)` : ''}, llama a ${r.method}() del puerto ${r.root.name}Repository, y SOLO ` +
        `entonces activa la nueva. Sin esa llamada las dos escrituras se vuelcan al commit en el orden que decide ` +
        `Hibernate y, si la activación sale primero, la transición legítima muere con el error de unicidad del ` +
        `diseño — un 409 en el camino feliz. No lo arregles quitando el índice: es el invariante que el diseño ` +
        `declaró. Lo verifica infra/check-idempotency.sh, familia conditionalUniqueness`
    )
    .join(' ');
}

/**
 * El contrato, para la cabecera del `.sql` que lo impone. Va ahí porque el archivo es el artefacto
 * que crea el índice: quien lo lea para entender qué garantiza tiene que leer también qué exige.
 */
export function sqlContract(model) {
  const relieving = relievingOperations(model);
  if (relieving.length === 0) return '';
  const ops = [...new Set(relieving.map((r) => r.operation.name))].join(', ');
  return `--
-- CONTRATO DE ORDEN. Un índice único parcial se comprueba por FILA y NO se puede diferir
-- (DEFERRABLE es de constraints, y una constraint única parcial no existe). Así que una
-- operación que RELEVA —saca una fila del estado condicionado y mete otra en el mismo acto—
-- tiene que confirmar la salida ANTES de la entrada, o habrá un instante con dos filas en ese
-- estado y la transición LEGÍTIMA morirá con este mismo error de unicidad.
--
-- Aquí releva: ${ops}. El puerto del agregado trae flushPendingWrites() para eso, y el handler
-- lo llama ENTRE las dos escrituras. Lo verifica infra/check-idempotency.sh.
`;
}
