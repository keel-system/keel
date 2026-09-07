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

import { partialUniqueIndexes } from './persistence-members.js';

/** Las entidades cuyo diseño declara al menos una unicidad condicionada. */
export function conditionedEntities(model) {
  if (model.persistenceKind === 'document') return [];
  return model.entities.filter((entity) => entity.persisted && partialUniqueIndexes(entity).length > 0);
}

/** Los estados condicionados de una entidad, tal como el diseño los nombra. */
const conditionedStates = (entity) =>
  new Set(partialUniqueIndexes(entity).map((index) => index.when.equals));

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
  const entities = conditionedEntities(model);
  if (entities.length === 0) return [];

  const out = [];
  for (const service of model.services ?? []) {
    for (const operation of service.operations ?? []) {
      for (const entity of entities) {
        const states = conditionedStates(entity);
        const suyas = (operation.transitions ?? []).filter((t) => t.entity === entity.name);
        const ocupa = suyas.filter((t) => states.has(t.to));
        const vacia = suyas.filter((t) => (t.from ?? []).some((from) => states.has(from)));
        if (ocupa.length > 0 && vacia.length > 0) {
          out.push({ operation, entity, state: ocupa[0].to, method: portMethodName(entity) });
        }
      }
    }
  }
  return out;
}

export const portMethodName = () => 'flushPendingWrites';

/** El método del puerto `<E>Repository`, solo para las entidades que lo necesitan. */
export function portMethods(model, entity) {
  if (!conditionedEntities(model).includes(entity)) return [];
  const states = [...conditionedStates(entity)].join(', ');
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
  if (!conditionedEntities(model).includes(entity)) return [];
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

  return relieving
    .map(
      (r) =>
        `ORDEN OBLIGATORIO (índice único condicionado sobre ${r.entity.name}.${r.state}): esta operación RELEVA — ` +
        `saca una fila de '${r.state}' y mete otra en el mismo acto—, y el índice se comprueba por FILA y no se ` +
        `puede diferir. Retira la que estaba, llama a ${r.method}() del puerto ${r.entity.name}Repository, y SOLO ` +
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
