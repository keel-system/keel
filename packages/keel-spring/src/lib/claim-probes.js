// El Java con el que `claim-check` ejercita el reclamo, y de dónde salen sus nombres.
//
// Misma regla que `broker-probes.js`, `mail-probes.js` y `mongo-probes.js`: lo que el runner
// ejecuta se renderiza AQUÍ, desde el modelo, y nunca se escribe a mano en el script. Un runner
// con sus propios nombres de método comprobaría que Postgres responde, no que el generador
// acierta — y el reclamo es justo el mecanismo donde eso importa, porque su núcleo es una
// cadena (el JPQL de un `@Query`) que javac da por buena diga lo que diga.
//
// Lo que se ejercita es el camino de PRODUCCIÓN: el adaptador que emite `claim.js`, con su
// `@Transactional(REQUIRES_NEW)`, su lote acotado por `parameters/` y su UPDATE condicional. El
// test no reimplementa ninguna consulta; solo prepara filas, llama y mira el resultado.
//
// **Falsado, no solo verde.** Se rompió el generador a propósito, dos veces, conservando la
// forma (compila y pasa `check-idempotency.sh`):
//
//   · el UPDATE pierde su condición de estado (`… or e.id = :id`) → rojo en
//     `elSegundoReclamoDeLaMismaFilaDevuelveCero`, y en NINGÚN otro;
//   · el rescate pierde su cota (`Instant.now()` en vez de `now().minusSeconds(plazo)`) → rojo
//     en `elRescateNoSeLlevaLoReciénPuestoEnVuelo`, y en ningún otro.
//
// **Y la GUARDA de un efecto irreversible se falsó en sus DOS ramas**, con la misma mutación en
// cada una: el JPQL pierde su condición de estado (`… or e.id = :id`) y el `Criteria` del
// `findAndModify` pierde su `.and("<estado>").in(...)`. Las dos siguen compilando, siguen siendo
// atómicas y siguen pasando el gate estático — solo que dejan de excluir. Cada una pone en rojo
// exactamente `laSegundaEjecucionDeLaMismaFilaNoSeLaLleva` y
// `laGuardaNoTocaUnaFilaQueYaNoEstaDisponible`, y ningún otro caso. Eso importa más aquí que en
// los demás mecanismos: lo que hay al otro lado de esta guarda es un correo que sale, y su fallo
// no produce ningún error —el servidor responde 2xx las dos veces— sino un segundo correo a una
// persona real. Ningún escenario `FL-*` lo ve, porque ningún arnés de caja negra mata la
// aplicación en esa ventana.
//
// **Y la medición del arnés se falsó dos veces más, con lo que aprendió cada una.** El bloque
// que ejercita el SQL del arnés junto al reclamo nació VACÍO: `claim-check` derivaba las
// columnas por su cuenta, así que romper el arnés lo dejaba en 11/11. Medía una segunda copia
// de la misma derivación, no al arnés — el defecto exacto que existe para detectar, y solo lo
// destapó la mutación. Con `rescueShape()` compartida:
//
//   · la columna del reloj sin `snakeCase` → los tres casos del arnés en rojo (error de SQL);
//   · la columna del reloj apuntando a una que EXISTE pero no es la del reclamo (`created_at`)
//     → rojo silencioso, que es el que importa: el UPDATE afecta a 1 fila y no falla, y lo que
//     cae es «el arnés atascó la fila pero el rescate no la encuentra». Ese es literalmente el
//     escenario de rescate que pasaría en verde en una corrida sin haber atascado nada.
//
// Y esa medición dejó un hallazgo sobre el propio check que conviene no perder:
// `elReclamoNoTocaFilasEnOtroEstado` NO vio la primera mutación, aunque parece el caso que
// cubre la exclusividad. Pasa por el adaptador, cuyo SELECT de candidatos sigue filtrando por
// estado, así que la fila ajena no llega nunca al UPDATE roto. La exclusividad solo la mide el
// caso que llama al método de Spring Data DIRECTAMENTE. Un test que atraviesa una capa que ya
// filtra no puede ver que la de debajo dejó de filtrar.

import { screamingSnake, snakeCase } from './naming.js';
import { DATABASES } from './stack-catalog.js';

// ─────────────────────────────────────────────────────────────────────────────
// El SQL con el que el ARNÉS fabrica la precondición del rescate.
//
// Vive aquí y no en `integration-tests.js` por lo mismo que los scripts de `mongo-probes.js`:
// es una cadena que nadie compila. La rama documental ya renderizaba de su módulo; la
// relacional lo componía en línea, y era la única de las dos sin fuente única.
//
// Y el defecto que eso deja abierto es el peor de todos: si la columna que este UPDATE nombra
// no es la que el reclamo lee —el arnés la deriva con `snakeCase(campo)`, el reclamo la lee por
// el `@Column` de la entidad—, el UPDATE afecta a CERO filas **sin fallar**, el barrido no
// encuentra nada y el escenario del rescate pasa en verde sin haber atascado nada. Las dos
// mitades son individualmente correctas y el par no prueba nada. Solo se ve ejecutando las dos
// juntas contra el motor, que es lo que hace `scripts/claim-check.js`.

/**
 * La FORMA de la tabla para un rescate: qué tabla, qué columna lleva el estado, qué constante
 * se guarda y qué columna lleva el reloj.
 *
 * Está aquí y no en el arnés porque es la mitad que hay que compartir de verdad. Extraer solo
 * las plantillas de SQL no bastó: `claim-check` seguía derivando las columnas por su cuenta, así
 * que medía una SEGUNDA COPIA de la misma derivación y no al arnés. Se vio rompiendo el arnés a
 * propósito —la columna del reloj sin `snakeCase`— y viendo el check seguir en verde con 11/11.
 * Con la derivación compartida, esa misma mutación lo pone rojo.
 */
export function rescueShape(entity, claim) {
  return {
    table: entity.tableName,
    stateColumn: snakeCase(entity.lifecycle.field),
    state: screamingSnake(claim.stalled.state),
    clockColumn: snakeCase(claim.stalled.stampField)
  };
}

/**
 * El orden del lote de un reclamo. Lo que no puede es quedarse sin ORDER BY: sin él el motor
 * devuelve las filas como le convenga y «el más antiguo primero», que es lo que casi todo
 * barrido promete, deja de cumplirse sin que nada falle.
 *
 * Vive aquí —y no en `scaffold/claim.js`, que es quien lo emite— por lo mismo que `rescueShape`:
 * es una DERIVACIÓN que dos sitios tienen que compartir. `claim-check` siembra sus filas con
 * instantes escalonados para comprobar que el lote empieza por la más antigua, y mientras el
 * nombre del campo estuvo escrito a mano allí (`createdAt`) el caso medía otra cosa en cuanto la
 * entidad ordenaba por otro —y con `notification-mailer`, que ordena por `requestedAt`, ni
 * siquiera compilaba—. Una segunda copia de esta regla es una copia que se separa.
 */
export function orderFieldOf(entity, claim) {
  // En un rescate el orden sale del propio reloj de la cota: el que más lleva atascado,
  // primero. Cualquier otro campo haría que una tanda con más atascados que batchSize
  // volviera a mirar siempre las mismas filas y las más viejas no se rescataran nunca.
  if (claim?.stalled) return claim.stalled.stampField;
  for (const candidate of ['createdAt', 'requestedAt', 'updatedAt']) {
    if (entity.fields.some((field) => field.name === candidate)) return candidate;
  }
  return 'id';
}

/**
 * Deja una fila EN VUELO con el reloj que se le pase. Devuelve el prefijo: el llamante le
 * concatena el literal del id, porque su forma depende del motor (`uuidLiteral`).
 */
export function stallSql({ table, stateColumn, state, clockColumn, clockSql }) {
  return `UPDATE ${table} SET ${stateColumn} = '${state}', ${clockColumn} = ${clockSql} WHERE id = `;
}

/**
 * Cuántas filas quedaron en un estado con el reloj SIN estampar.
 *
 * Tiene que discriminar de verdad: un predicado que devolviera siempre cero pasaría el
 * escenario del rescate sin ver el defecto para el que existe.
 */
export function missingClockCountSql({ table, stateColumn, state, clockColumn }) {
  return `SELECT COUNT(*) FROM ${table} WHERE ${stateColumn} = '${state}' AND ${clockColumn} IS NULL`;
}

/**
 * Los casos de la GUARDA de un efecto externo irreversible, comunes a las dos ramas.
 *
 * Comunes de verdad y no por ahorro: lo único que cambia entre el `@Modifying` condicional y el
 * `findAndModify` es CÓMO se relee la fila, y eso entra por parámetro. Lo que se afirma es lo
 * mismo porque la promesa es la misma, y escribir dos versiones invitaría a que una se quedara
 * atrás — que es como se pierde cobertura sin que nada lo diga.
 *
 * Y la promesa que se está midiendo no es «marca la fila»: es que **la segunda ejecución no se
 * la lleve**. Al otro lado hay un correo que sale, y un reclamo que no excluye no produce un
 * error visible — produce un segundo correo a una persona real, que ningún escenario `FL-*` ve
 * porque ningún arnés de caja negra mata la aplicación en esa ventana. Hasta ahora este
 * mecanismo solo lo miraban comparaciones de cadenas y un gate estático.
 */
function guardTests({ guard, constant, documento, lee, statusGetter, guardStampGetter }) {
  const desde = constant(guard.from[0]);
  return `
    @Test
    void laGuardaSeLlevaLaFilaYEstampaSuMarca() {
        UUID id = ${documento}(${desde}, null, Instant.now());

        var reclamada = adaptador.${guard.method}(id);

        assertTrue(reclamada.isPresent(), "la guarda no se llevó una fila que estaba disponible");
        assertEquals(${constant(guard.to)}, ${lee('id')}.${statusGetter}(), "la fila no quedó en el estado intermedio");${
          guardStampGetter
            ? `
        // La marca va en la MISMA escritura que el estado: es la que el rescate del barrido
        // consulta para saber si la ejecución que se llevó la fila murió a medias. Estamparla
        // después deja una ventana en la que la fila queda reclamada y sin instante, y ahí no la
        // recoge nadie nunca.
        assertNotNull(${lee('id')}.${guardStampGetter}(), "la guarda no estampó la marca que el rescate consulta");`
            : ''
        }
    }

    @Test
    void laSegundaEjecucionDeLaMismaFilaNoSeLaLleva() {
        // ESTE es el caso. La guarda existe para que dos ejecuciones concurrentes no manden el
        // mismo correo dos veces, y lo que lo impide es la condición de estado en la escritura.
        // Sin ella las dos vuelven con la fila en la mano, las dos envían, y no falla nada: el
        // servidor responde 2xx las dos veces y quien lo nota es el destinatario.
        UUID id = ${documento}(${desde}, null, Instant.now());

        var primera = adaptador.${guard.method}(id);
        var segunda = adaptador.${guard.method}(id);

        assertTrue(primera.isPresent(), "la primera ejecución tenía que llevarse la fila");
        assertFalse(segunda.isPresent(), "la segunda ejecución también se llevó la fila: el efecto se repite");
    }

    @Test
    void laGuardaNoTocaUnaFilaQueYaNoEstaDisponible() {
        // La fila ya está en el estado intermedio —otra ejecución la tomó— y aquí llega un
        // reintento con el mismo id. Tiene que volver vacío y NO volver a mover nada.
        UUID ajena = ${documento}(${constant(guard.to)}, null, Instant.now());

        var reclamada = adaptador.${guard.method}(ajena);

        assertFalse(reclamada.isPresent(), "la guarda se llevó una fila que no estaba en su estado de partida");
        assertEquals(${constant(guard.to)}, ${lee('ajena')}.${statusGetter}(), "y además la movió");
    }`;
}

/** Dónde vive el test dentro del proyecto generado, y cómo se llama. */
export const PACKAGE_LEAF = 'claimcheck';
export const CLASS_NAME = 'ClaimCheckTest';

/** El lote se fija pequeño a propósito: con el default (100) no se puede ver la cota. */
export const BATCH_SIZE = 3;

/**
 * Qué reclamos genera este diseño y con qué piezas se ejercitan.
 *
 * Devuelve la PRIMERA entidad con reclamos y sus dos clases: la de cola (la que estampa el
 * reloj) y la de rescate (la que lleva cota temporal). Un diseño sin reclamos devuelve la lista
 * vacía y el runner lo dice en voz alta en vez de ejecutar una suite que no mira nada.
 */
export function claimScenarios(model) {
  const operations = (model.services ?? []).flatMap((service) => service.operations ?? []);
  // La GUARDA de un efecto externo irreversible vive en `operation.guardClaim` y no en
  // `operation.claim` —son mecanismos distintos: uno reclama un LOTE que el barrido elige, la
  // otra reclama UNA fila cuyo id ya le dieron—, así que mirar solo `claim` la dejaba fuera. Y
  // es la que peor se puede permitir estar fuera: lo que hay al otro lado es un correo que sale,
  // y un reclamo que no excluye manda el segundo a una persona real.
  const guards = operations.map((operation) => operation.guardClaim).filter(Boolean);
  const entityOf = (name) => (model.entities ?? []).find((candidate) => candidate.name === name);

  for (const operation of operations) {
    const claims = operation.claim ?? [];
    if (claims.length === 0) continue;
    const entityName = claims[0].entity;
    const entity = entityOf(entityName);
    if (!entity?.lifecycle) continue;
    return {
      operation: operation.name,
      entity,
      enumType: entity.lifecycle.enumType,
      statusField: entity.lifecycle.field,
      claims: claims.filter((claim) => claim.entity === entityName),
      queue: claims.find((claim) => claim.entity === entityName && !claim.stalled) ?? null,
      rescue: claims.find((claim) => claim.entity === entityName && claim.stalled) ?? null,
      // Solo la del MISMO agregado: sembrar dos entidades distintas en una suite pensada para
      // una sería otra cosa, y la guarda de otro agregado merece su propia pasada.
      guard: guards.find((candidate) => candidate.entity === entityName) ?? null
    };
  }

  // Un diseño sin barridos pero con guarda: entonces el sujeto es ella.
  for (const guard of guards) {
    const entity = entityOf(guard.entity);
    if (!entity?.lifecycle) continue;
    return {
      operation: guard.operation,
      entity,
      enumType: entity.lifecycle.enumType,
      statusField: entity.lifecycle.field,
      claims: [],
      queue: null,
      rescue: null,
      guard
    };
  }

  return { claims: [] };
}

/** El nombre del getter/setter de un campo, como los emite el scaffold de entidades. */
export const accessor = (prefix, field) => `${prefix}${field.charAt(0).toUpperCase()}${field.slice(1)}`;

/**
 * Los campos que hay que rellenar para que la fila entre en la tabla, con su literal.
 *
 * Se derivan de los NOT NULL de la entidad —no de una lista escrita a mano— porque una fixture
 * con un campo obligatorio más produciría un INSERT que el motor rechaza, y el fallo aparecería
 * como «el reclamo no se llevó nada», que es indistinguible del defecto que se persigue.
 *
 * <p>Exportada porque `store-probes.js` siembra las mismas filas para el reclamo de
 * reconciliación y necesita la MISMA derivación: una segunda copia de esta regla es una copia que
 * se separa, y el día que se separe el síntoma será otra vez «no se llevó nada». Solo lee
 * `entity` y `statusField` del objeto que recibe, así que le sirve cualquiera que traiga esos
 * dos — no hace falta un `scenarios` de claim-check.
 */
export function requiredLiterals(scenarios, clockField, orderField) {
  // El campo por el que se ordena el lote lo pone la siembra con su instante escalonado, así que
  // aquí se excluye: ponerlo dos veces daría a todas las filas el mismo instante y el caso del
  // orden dejaría de poder fallar.
  const reservados = new Set([scenarios.statusField, clockField, orderField, 'createdAt', 'updatedAt', 'lockVersion']);
  const literals = [];
  for (const field of scenarios.entity.fields ?? []) {
    if (field.isId || reservados.has(field.name) || !field.required) continue;
    if (field.list) throw new Error(`claim-check: el campo obligatorio '${field.name}' es una lista y no sé sembrarlo`);
    // Un formato declarado no se puede satisfacer con un valor fabricado, y Hibernate aplica la
    // validación al persistir: el INSERT lo rechazaría en la siembra y todos los casos caerían a
    // la vez con un error que no habla del reclamo. Mejor decirlo aquí, nombrando el campo.
    if (field.inheritedPattern || (field.validation ?? []).some((rule) => rule.startsWith('@Pattern'))) {
      throw new Error(
        `claim-check: el campo obligatorio '${field.name}' declara un formato y no sé fabricar un valor que lo cumpla`
      );
    }
    const literal = literalFor(field);
    literals.push(`        row.${accessor('set', field.name)}(${literal});`);
  }
  return literals;
}

/**
 * La cota de longitud que el propio generador le puso a la columna. Sale del `@Column` que build
 * emite —la misma fuente que el DDL— y no de la validación del DTO, que describe otra cosa.
 */
function maxLengthOf(field) {
  const declared = (field.columns ?? []).join(' ').match(/length = (\d+)/);
  if (declared) return Number(declared[1]);
  const size = (field.validation ?? []).join(' ').match(/@Size\(max = (\d+)\)/);
  return size ? Number(size[1]) : null;
}

function literalFor(field) {
  switch (field.javaType) {
    case 'String': {
      // Un valor fabricado tiene que caber en su columna. Sin esto, un campo con `maxLength: 10`
      // —un `locale`, por ejemplo— rechazaba el INSERT con «value too long», y como eso ocurre en
      // la siembra, TODOS los casos caían a la vez con un error que no habla del reclamo.
      const max = maxLengthOf(field);
      // Y tiene que seguir siendo ÚNICO por fila: un campo obligatorio suele ser además la clave
      // natural, y repetir el valor haría fallar el segundo INSERT por unicidad en vez de por lo
      // que se mide. De ahí que al recortar se conserve el uuid y no el prefijo legible: cortar
      // `"claim-check-…"` a diez caracteres da el MISMO texto para todas las filas.
      if (max !== null && max < 48) {
        return `java.util.UUID.randomUUID().toString().substring(0, ${Math.min(max, 36)})`;
      }
      return '"claim-check-" + java.util.UUID.randomUUID()';
    }
    case 'Integer':
    case 'int':
      return '1';
    case 'Long':
    case 'long':
      return '1L';
    case 'BigDecimal':
      return 'java.math.BigDecimal.ONE';
    case 'Boolean':
    case 'boolean':
      return 'false';
    case 'Instant':
      return 'Instant.now()';
    case 'UUID':
      return 'java.util.UUID.randomUUID()';
    default:
      // Un enum del diseño: cualquiera de sus constantes vale, y `values()[0]` no depende de
      // cómo se llamen. Si no es un enum, el Java no compilará y el fallo será explícito.
      return `${field.javaType}.values()[0]`;
  }
}

/** Una cadena Java con las comillas escapadas. El SQL del arnés lleva las suyas dentro. */
const javaLiteral = (text) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * El SQL del ARNÉS para este rescate, renderizado de las mismas funciones que usa
 * `integration-tests.js`. Devuelve `null` donde el motor no declara su forma —es el mismo
 * criterio con el que el arnés no emite el helper: inventarla es peor que no tenerlo.
 */
export function harnessProbes(scenarios, database) {
  const { entity, rescue } = scenarios;
  if (!rescue) return null;
  // El motor lo pasa quien renderiza: `buildModel` no lo deja en el modelo, y leerlo de ahí
  // daba `undefined` en silencio — el bloque no se emitía y la suite salía en verde con tres
  // casos menos, que es la forma exacta de perder cobertura sin que nada lo diga.
  const engine = DATABASES[database];
  if (!engine?.staleTimestamp || !engine?.uuidLiteral || !entity.tableName) return null;

  const shape = rescueShape(entity, rescue);
  return {
    stall: stallSql({ ...shape, clockSql: engine.staleTimestamp }),
    // El reloj «a ahora» sale de la misma fuente que el del arnés (`nowTimestamp`, con el ANSI
    // por defecto): lo que se mide es SU SQL, no una versión propia. Escribirlo aquí a mano
    // volvería a medir una segunda copia de la derivación, que es el defecto que ya destapó una
    // mutación en este mismo módulo.
    fresh: stallSql({ ...shape, clockSql: engine.nowTimestamp ?? 'CURRENT_TIMESTAMP' }),
    missingClock: missingClockCountSql(shape),
    uuidPrefix: engine.uuidLiteral.prefix,
    uuidSuffix: engine.uuidLiteral.suffix
  };
}

/**
 * El JUnit que ejercita el reclamo contra el motor real.
 *
 * @param {object} model              modelo del servicio
 * @param {object} scenarios          salida de `claimScenarios`
 * @param {object} opts.datasource    la conexión que build emitió en parameters/local/db.yaml
 * @param {object} opts.packages      paquete real de cada clase, leído del proyecto generado
 * @param {string} opts.database      motor elegido: de él salen el reloj rancio y el literal de uuid
 */
export function claimTestClass(model, scenarios, options) {
  return model.persistenceKind === 'document'
    ? documentClaimTestClass(model, scenarios, options)
    : relationalClaimTestClass(model, scenarios, options);
}

/**
 * La misma medición sobre la rama DOCUMENTAL, que no comparte una línea de código con la otra.
 *
 * Aquí el reclamo no es un `@Modifying` sobre JPQL sino un bucle de `findAndModify` con su
 * `Criteria` y su `returnNew(true)`, y hasta ahora no lo ejecutaba nadie: `mongo-check` ejercita
 * los scripts del ARNÉS contra Mongo, pero el reclamo en sí solo lo miraban comparaciones de
 * cadenas. Su modo de fallo es el mismo de siempre y es silencioso — un `Criteria` que no casa
 * con nada no falla: devuelve `null`, el bucle corta en la primera vuelta y el barrido reclama
 * cero documentos como si la cola estuviera vacía.
 *
 * Y hay una diferencia que cambia lo que se puede medir: en la rama relacional el adaptador
 * SELECCIONA candidatos y luego los reclama, así que la exclusividad solo se ve llamando al
 * método de Spring Data directamente (el SELECT ya filtró). Aquí el `findAndModify` ES el
 * reclamo entero, así que llamar dos veces al adaptador sí mide la condición de estado.
 */
function documentClaimTestClass(model, scenarios, { datasource, packages }) {
  const { entity, enumType, statusField, queue, rescue, guard } = scenarios;
  const documentClass = `${entity.name}Document`;
  const portClass = `${entity.name}Repository`;
  const adapterClass = `${entity.name}RepositoryImpl`;
  const clockField = queue?.stamps?.field ?? rescue?.stalled?.stampField ?? null;
  const statusSetter = accessor('set', statusField);
  const statusGetter = accessor('get', statusField);
  const clockSetter = clockField ? accessor('set', clockField) : null;
  const clockGetter = clockField ? accessor('get', clockField) : null;
  // El reloj de la GUARDA va aparte del de la cola y el del rescate: son marcas distintas, y
  // colarla en el mismo campo haría que el caso de la cola afirmara un estampado que ese reclamo
  // no hace. La fila se siembra SIN ella (no se pone nunca), que es la precondición del caso.
  const guardStampGetter = guard?.stampField ? accessor('get', guard.stampField) : null;
  // Por qué campo ordena el lote su reclamo, que es el que la siembra escalona. Sale de la MISMA
  // función que usa el generador: escrito a mano aquí (`createdAt`) el caso del orden medía otra
  // cosa en cuanto la entidad ordenaba por otro campo — y con una que no lo declara, ni compilaba.
  const orderField = orderFieldOf(entity, queue ?? rescue ?? null);
  const orderSetter = orderField === 'id' ? null : accessor('set', orderField);

  const constant = (state) => `${enumType}.${screamingSnake(state)}`;

  const properties = [
    `"spring.data.mongodb.uri=${datasource.uri}"`,
    // El perfil `test` trae el mongod EMBEBIDO (flapdoodle) y su gestor de transacciones no-op.
    // Sin apagarlo, esta suite mediría una base en memoria y saldría en verde sin haber tocado
    // el contenedor — el gemelo exacto del `@AutoConfigureTestDatabase(Replace.NONE)` de la
    // rama relacional. La aserción de abajo es lo que hace fallable esta decisión.
    '"spring.profiles.active="',
    ...(queue ? [`"sweep.${queue.sweepKey}.batch-size=${BATCH_SIZE}"`] : []),
    ...(rescue ? [`"sweep.${rescue.stalled.configKey}.stalled-after-seconds=${rescue.stalled.defaultSeconds}"`] : [])
  ];

  const scalars = new Set(['String', 'Integer', 'int', 'Long', 'long', 'BigDecimal', 'Boolean', 'boolean', 'Instant', 'UUID']);
  const enumImports = [
    ...new Set(
      (entity.fields ?? [])
        .filter((field) => field.required && !field.isId && !field.list && !scalars.has(field.javaType))
        .map((field) => field.javaType)
        .filter((type) => type !== enumType)
    )
  ].map((type) => `${packages.enums}.${type}`);

  const imports = [
    `${packages.enums}.${enumType}`,
    ...enumImports,
    `${packages.port}.${portClass}`,
    `${packages.entities}.${documentClass}`,
    `${packages.repositories}.${adapterClass}`,
    'java.time.Instant',
    'java.util.UUID',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.autoconfigure.ImportAutoConfiguration',
    'org.springframework.boot.test.autoconfigure.data.mongo.DataMongoTest',
    'org.springframework.context.annotation.Import',
    'org.springframework.data.mongodb.core.MongoTemplate',
    'org.springframework.data.mongodb.core.query.Query',
    'de.flapdoodle.embed.mongo.spring.autoconfigure.EmbeddedMongoAutoConfiguration',
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertNotNull',
    'static org.junit.jupiter.api.Assertions.assertNull',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ];

  const tests = [];

  // La aserción que hace fallable todo lo demás: si el contexto arrancara contra el mongod
  // embebido, esta suite entera estaría midiendo una base en memoria con el reclamo real, y
  // saldría en verde sin haber ejercitado el contenedor. Se mira el NOMBRE de la base (el
  // embebido usa `testdb`) y el replica set (flapdoodle arranca standalone).
  tests.push(`
    @Test
    void seMideLaBaseDelContenedorYNoUnMongodEmbebido() {
        assertEquals("${model.service.name.replaceAll('-', '_')}", mongo.getDb().getName(),
                "la suite está hablando con otra base: el mongod embebido del perfil test");
        assertNotNull(mongo.getDb().runCommand(new org.bson.Document("hello", 1)).getString("setName"),
                "el servidor no es miembro de un replica set: es el embebido, no el de infra/");
    }`);

  if (queue) {
    tests.push(`
    @Test
    void elReclamoDeLaColaSeLlevaElDocumentoYEstampaElReloj() {
        UUID id = documento(${constant(queue.from[0])}, null, Instant.now());

        var reclamadas = adaptador.${queue.method}();

        assertEquals(1, reclamadas.size(), "el reclamo no se llevó el documento que estaba en su estado de partida");
        ${documentClass} despues = mongo.findById(id, ${documentClass}.class);
        assertEquals(${constant(queue.to)}, despues.${statusGetter}(), "el documento no quedó en el estado de destino");${
          clockGetter
            ? `
        // El reloj va en el MISMO findAndModify que el estado, por lo mismo que en la rama
        // relacional: estamparlo después deja una ventana en la que el documento queda
        // reclamado con la marca a null, y ahí ya no lo recoge nadie.
        assertNotNull(despues.${clockGetter}(), "el reclamo no estampó el reloj que el rescate consulta");`
            : ''
        }
    }

    @Test
    void elReclamoNoTocaDocumentosEnOtroEstado() {
        UUID ajena = documento(${constant(queue.to)}, Instant.now(), Instant.now());

        var reclamadas = adaptador.${queue.method}();

        assertTrue(reclamadas.isEmpty(), "el reclamo se llevó un documento que no estaba en su estado de partida");
        assertEquals(${constant(queue.to)}, mongo.findById(ajena, ${documentClass}.class).${statusGetter}(), "y además lo movió");
    }

    @Test
    void elSegundoReclamoDelMismoDocumentoNoDevuelveNada() {
        // La exclusión mutua entera. Aquí el findAndModify ES el reclamo —no hay un SELECT de
        // candidatos delante que ya filtre—, así que llamar dos veces al adaptador sí mide la
        // condición de estado: un Criteria sin ella devolvería el mismo documento las dos veces
        // y dos réplicas creerían haberse llevado el trabajo.
        documento(${constant(queue.from[0])}, null, Instant.now());

        var primera = adaptador.${queue.method}();
        var segunda = adaptador.${queue.method}();

        assertEquals(1, primera.size(), "el primer reclamo tenía que llevarse el documento");
        assertTrue(segunda.isEmpty(), "el segundo reclamo se llevó un documento que ya no estaba disponible");
    }

    @Test
    void elLoteVaAcotadoPorSuParametro() {
        for (int i = 0; i < ${BATCH_SIZE} + 2; i++) {
            documento(${constant(queue.from[0])}, null, Instant.now().minusSeconds(100 - i));
        }

        var reclamadas = adaptador.${queue.method}();

        assertEquals(${BATCH_SIZE}, reclamadas.size(), "el barrido se llevó más de lo que su parámetro permite");
    }

    @Test
    void elLoteEmpiezaPorLoMasAntiguo() {
        // Sin el sort, una pasada puede volver siempre sobre los mismos documentos y dejar el
        // fondo de la cola sin atender. Eso no lo ve ninguna aserción de cadenas.
        UUID vieja = documento(${constant(queue.from[0])}, null, Instant.now().minusSeconds(900));
        for (int i = 0; i < ${BATCH_SIZE} + 2; i++) {
            documento(${constant(queue.from[0])}, null, Instant.now().minusSeconds(10));
        }

        adaptador.${queue.method}();

        assertEquals(${constant(queue.to)}, mongo.findById(vieja, ${documentClass}.class).${statusGetter}(),
                "el documento más antiguo se quedó fuera del lote");
    }`);
  }

  if (rescue && clockGetter) {
    const plazo = rescue.stalled.defaultSeconds;
    tests.push(`
    @Test
    void elRescateNoSeLlevaLoReciénPuestoEnVuelo() {
        UUID enVuelo = documento(${constant(rescue.from[0])}, Instant.now(), Instant.now());

        var reclamadas = adaptador.${rescue.method}();

        assertTrue(reclamadas.isEmpty(), "el rescate se llevó un documento que otra réplica acaba de tomar");
        assertEquals(${constant(rescue.from[0])}, mongo.findById(enVuelo, ${documentClass}.class).${statusGetter}(), "y lo movió");
    }

    @Test
    void elRescateSeLlevaLoRancio() {
        UUID abandonada = documento(${constant(rescue.from[0])}, Instant.now().minusSeconds(${plazo} + 60), Instant.now());

        var reclamadas = adaptador.${rescue.method}();

        assertEquals(1, reclamadas.size(), "el rescate no encontró un documento abandonado más tiempo que el plazo");
        assertEquals(${constant(rescue.to)}, mongo.findById(abandonada, ${documentClass}.class).${statusGetter}(), "no lo movió");
    }

    @Test
    void unDocumentoEnVueloSinRelojNoLoRecogeNadie() {
        // La propiedad equivalente a la del NULL en SQL, y NO es la misma: aquí el campo puede
        // estar AUSENTE, y un \`$lt\` no casa un campo ausente. El efecto para el negocio es
        // idéntico —ese documento no vuelve a entrar en ningún lote jamás— y por eso se afirma
        // donde se puede comprobar.
        UUID sinReloj = documento(${constant(rescue.from[0])}, null, Instant.now().minusSeconds(${plazo} + 600));

        var reclamadas = adaptador.${rescue.method}();

        assertTrue(reclamadas.isEmpty(), "el rescate recogió un documento sin reloj: la semántica cambió");
        assertNull(mongo.findById(sinReloj, ${documentClass}.class).${clockGetter}(), "el documento dejó de estar sin reloj");
        assertEquals(${constant(rescue.from[0])}, mongo.findById(sinReloj, ${documentClass}.class).${statusGetter}(), "y se movió");
    }`);
  }

  if (guard) {
    tests.push(guardTests({
      guard,
      constant,
      documento: 'documento',
      lee: (id) => `mongo.findById(${id}, ${documentClass}.class)`,
      statusGetter,
      guardStampGetter
    }));
  }

  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${imports.map((entry) => `import ${entry};`).join('\n')}

/**
 * El reclamo DOCUMENTAL generado, ejercitado contra el Mongo real que levanta infra/.
 *
 * <p>Lo escribe scripts/claim-check.js desde src/lib/claim-probes.js: no es parte del proyecto
 * generado y no se versiona con él.
 *
 * <p><b>Contra el contenedor, no contra el embebido.</b> El perfil {@code test} de un proyecto
 * documental arranca flapdoodle —un mongod en memoria y standalone—, así que aquí se desactiva
 * el perfil y se excluye su autoconfiguración. Si eso fallara, la suite entera pasaría midiendo
 * una base que no es la de infra/: por eso el primer caso lo AFIRMA.
 *
 * <p>La mitad del ARNÉS —los scripts de mongosh con los que se fabrica la precondición— no se
 * repite aquí: la ejercita {@code npm run mongo-check} contra este mismo Mongo, desde
 * {@code src/lib/mongo-probes.js}. Lo de aquí es el reclamo.
 */
@DataMongoTest(properties = {
        ${properties.join(',\n        ')}
})
@ImportAutoConfiguration(exclude = EmbeddedMongoAutoConfiguration.class)
@Import(${adapterClass}.class)
class ${CLASS_NAME} {

    @Autowired
    private MongoTemplate mongo;

    @Autowired
    private ${portClass} adaptador;

    @BeforeEach
    void limpia() {
        mongo.remove(new Query(), ${documentClass}.class);
    }

    /** Un documento en el estado y con el reloj que pide el caso. */
    private UUID documento(${enumType} estado, Instant reloj, Instant creada) {
        ${documentClass} row = new ${documentClass}();
        row.setId(UUID.randomUUID());
        row.${statusSetter}(estado);${clockSetter ? `
        row.${clockSetter}(reloj);` : ''}
${orderSetter ? `        row.${orderSetter}(creada);` : `        // ${orderField} no es un campo sembrable: el lote se ordena por id`}
${requiredLiterals(scenarios, clockField, orderField).join('\n')}
        mongo.save(row);
        return row.getId();
    }
${tests.join('\n')}
}
`;
}

function relationalClaimTestClass(model, scenarios, { datasource, packages, database }) {
  const { entity, enumType, statusField, queue, rescue, guard } = scenarios;
  const jpaClass = `${entity.name}Jpa`;
  const portClass = `${entity.name}Repository`;
  const jpaRepoClass = `${entity.name}JpaRepository`;
  const adapterClass = `${entity.name}RepositoryImpl`;
  const clockField = queue?.stamps?.field ?? rescue?.stalled?.stampField ?? null;
  const statusSetter = accessor('set', statusField);
  const statusGetter = accessor('get', statusField);
  const clockSetter = clockField ? accessor('set', clockField) : null;
  const clockGetter = clockField ? accessor('get', clockField) : null;
  // El reloj de la GUARDA va aparte del de la cola y el del rescate: son marcas distintas, y
  // colarla en el mismo campo haría que el caso de la cola afirmara un estampado que ese reclamo
  // no hace. La fila se siembra SIN ella (no se pone nunca), que es la precondición del caso.
  const guardStampGetter = guard?.stampField ? accessor('get', guard.stampField) : null;
  // Por qué campo ordena el lote su reclamo, que es el que la siembra escalona. Sale de la MISMA
  // función que usa el generador: escrito a mano aquí (`createdAt`) el caso del orden medía otra
  // cosa en cuanto la entidad ordenaba por otro campo — y con una que no lo declara, ni compilaba.
  const orderField = orderFieldOf(entity, queue ?? rescue ?? null);
  const orderSetter = orderField === 'id' ? null : accessor('set', orderField);

  const harness = harnessProbes(scenarios, database);

  const constant = (state) => `${enumType}.${screamingSnake(state)}`;
  const stateList = (claim) => `List.of(${claim.from.map(constant).join(', ')})`;

  const properties = [
    `"spring.datasource.url=${datasource.url}"`,
    `"spring.datasource.username=${datasource.username}"`,
    `"spring.datasource.password=${datasource.password ?? ''}"`,
    '"spring.jpa.hibernate.ddl-auto=create-drop"',
    '"spring.flyway.enabled=false"',
    ...(queue ? [`"sweep.${queue.sweepKey}.batch-size=${BATCH_SIZE}"`] : []),
    ...(rescue ? [`"sweep.${rescue.stalled.configKey}.stalled-after-seconds=${rescue.stalled.defaultSeconds}"`] : [])
  ];

  // Los enums de los campos obligatorios también se importan: la fila se siembra con
  // `<Enum>.values()[0]`, y sin el import el Java no compila. Se descubren del modelo, no de una
  // lista: una fixture con otro enum obligatorio traería otro nombre.
  const scalars = new Set(['String', 'Integer', 'int', 'Long', 'long', 'BigDecimal', 'Boolean', 'boolean', 'Instant', 'UUID']);
  const enumImports = [
    ...new Set(
      (entity.fields ?? [])
        .filter((field) => field.required && !field.isId && !field.list && !scalars.has(field.javaType))
        .map((field) => field.javaType)
        .filter((type) => type !== enumType)
    )
  ].map((type) => `${packages.enums}.${type}`);

  const imports = [
    `${packages.enums}.${enumType}`,
    ...enumImports,
    `${packages.port}.${portClass}`,
    `${packages.entities}.${jpaClass}`,
    `${packages.repositories}.${jpaRepoClass}`,
    `${packages.repositories}.${adapterClass}`,
    'jakarta.persistence.EntityManager',
    'java.time.Instant',
    'java.util.List',
    'java.util.UUID',
    'org.junit.jupiter.api.BeforeEach',
    'org.junit.jupiter.api.Test',
    'org.springframework.beans.factory.annotation.Autowired',
    'org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase',
    'org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest',
    'org.springframework.context.annotation.Import',
    'org.springframework.transaction.PlatformTransactionManager',
    'org.springframework.transaction.annotation.Propagation',
    'org.springframework.transaction.annotation.Transactional',
    'org.springframework.transaction.support.TransactionTemplate',
    'static org.junit.jupiter.api.Assertions.assertEquals',
    'static org.junit.jupiter.api.Assertions.assertFalse',
    'static org.junit.jupiter.api.Assertions.assertNotNull',
    'static org.junit.jupiter.api.Assertions.assertNull',
    'static org.junit.jupiter.api.Assertions.assertTrue'
  ];

  const tests = [];

  if (queue) {
    tests.push(`
    @Test
    void elReclamoDeLaColaSeLlevaLaFilaYEstampaElReloj() {
        UUID id = fila(${constant(queue.from[0])}, null, Instant.now());

        var reclamadas = adaptador.${queue.method}();

        assertEquals(1, reclamadas.size(), "el reclamo no se llevó la fila que estaba en su estado de partida");
        ${jpaClass} despues = jpa.findById(id).orElseThrow();
        assertEquals(${constant(queue.to)}, despues.${statusGetter}(), "la fila no quedó en el estado de destino");${
          clockGetter
            ? `
        // El reloj va en el MISMO update que el estado. Estamparlo después deja una ventana en
        // la que la fila queda reclamada con la marca a NULL, y ahí ya no la recoge nadie.
        assertNotNull(despues.${clockGetter}(), "el reclamo no estampó el reloj que el rescate consulta");`
            : ''
        }
    }

    @Test
    void elReclamoNoTocaFilasEnOtroEstado() {
        UUID ajena = fila(${constant(queue.to)}, Instant.now(), Instant.now());

        var reclamadas = adaptador.${queue.method}();

        assertTrue(reclamadas.isEmpty(), "el reclamo se llevó una fila que no estaba en su estado de partida");
        assertEquals(${constant(queue.to)}, jpa.findById(ajena).orElseThrow().${statusGetter}(), "y además la movió");
    }

    @Test
    void elSegundoReclamoDeLaMismaFilaDevuelveCero() {
        // La exclusión mutua entera: el UPDATE condicional. 1 = era mía; 0 = otra llegó antes.
        // Sin esto, un predicado que casara siempre daría 1 las dos veces y las dos réplicas
        // creerían haberse llevado el trabajo.
        UUID id = fila(${constant(queue.from[0])}, null, Instant.now());
        List<${enumType}> estados = ${stateList(queue)};

        int primero = tx.execute(status -> jpa.${queue.method}(id, estados, ${constant(queue.to)}${queue.stamps ? ', Instant.now()' : ''}));
        int segundo = tx.execute(status -> jpa.${queue.method}(id, estados, ${constant(queue.to)}${queue.stamps ? ', Instant.now()' : ''}));

        assertEquals(1, primero, "el primer reclamo tenía que llevarse la fila");
        assertEquals(0, segundo, "el segundo reclamo se llevó una fila que ya no estaba disponible");
    }

    @Test
    void elLoteVaAcotadoPorSuParametro() {
        for (int i = 0; i < ${BATCH_SIZE} + 2; i++) {
            fila(${constant(queue.from[0])}, null, Instant.now().minusSeconds(100 - i));
        }

        var reclamadas = adaptador.${queue.method}();

        assertEquals(${BATCH_SIZE}, reclamadas.size(), "el barrido se llevó más de lo que su parámetro permite");
    }

    @Test
    void elLoteEmpiezaPorLoMasAntiguo() {
        // Sin orden determinista, una pasada puede volver siempre sobre las mismas filas y
        // dejar el fondo de la cola sin atender. Eso no lo ve ninguna aserción de cadenas.
        UUID vieja = fila(${constant(queue.from[0])}, null, Instant.now().minusSeconds(900));
        for (int i = 0; i < ${BATCH_SIZE} + 2; i++) {
            fila(${constant(queue.from[0])}, null, Instant.now().minusSeconds(10));
        }

        adaptador.${queue.method}();

        assertEquals(${constant(queue.to)}, jpa.findById(vieja).orElseThrow().${statusGetter}(),
                "la fila más antigua se quedó fuera del lote");
    }`);
  }

  if (rescue && clockGetter) {
    const plazo = rescue.stalled.defaultSeconds;
    tests.push(`
    @Test
    void elRescateNoSeLlevaLoReciénPuestoEnVuelo() {
        // La cota temporal es lo único que separa rescatar de arrancarle el trabajo de las
        // manos a la réplica que lo está haciendo. Un predicado sin ella pasa igual todos los
        // tests de cadenas.
        UUID enVuelo = fila(${constant(rescue.from[0])}, Instant.now(), Instant.now());

        var reclamadas = adaptador.${rescue.method}();

        assertTrue(reclamadas.isEmpty(), "el rescate se llevó una fila que otra réplica acaba de tomar");
        assertEquals(${constant(rescue.from[0])}, jpa.findById(enVuelo).orElseThrow().${statusGetter}(), "y la movió");
    }

    @Test
    void elRescateSeLlevaLoRancio() {
        UUID abandonada = fila(${constant(rescue.from[0])}, Instant.now().minusSeconds(${plazo} + 60), Instant.now());

        var reclamadas = adaptador.${rescue.method}();

        assertEquals(1, reclamadas.size(), "el rescate no encontró una fila que lleva abandonada más que el plazo");
        assertEquals(${constant(rescue.to)}, jpa.findById(abandonada).orElseThrow().${statusGetter}(), "no la movió");
    }

    @Test
    void unaFilaEnVueloSinRelojNoLaRecogeNadie() {
        // El defecto que el javadoc del reclamo anuncia y que ningún escenario ve: en SQL,
        // NULL < :cota no es falso, es UNKNOWN. Una fila que quedó en vuelo sin marca no vuelve
        // a entrar en ningún lote NUNCA. Se afirma para que la propiedad quede documentada donde
        // se pueda comprobar: si algún día el motor o el JPQL cambian esta semántica, se ve aquí
        // y no en producción.
        UUID sinReloj = fila(${constant(rescue.from[0])}, null, Instant.now().minusSeconds(${plazo} + 600));

        var reclamadas = adaptador.${rescue.method}();

        assertTrue(reclamadas.isEmpty(), "el rescate recogió una fila sin reloj: la semántica de NULL cambió");
        assertNull(jpa.findById(sinReloj).orElseThrow().${clockGetter}(), "la fila dejó de estar sin reloj");
        assertEquals(${constant(rescue.from[0])}, jpa.findById(sinReloj).orElseThrow().${statusGetter}(), "y se movió");
    }`);
  }

  // ─── El arnés y el reclamo, MEDIDOS JUNTOS ─────────────────────────────────
  //
  // Lo de arriba mide el reclamo con filas que siembra este test. Pero en una corrida la
  // precondición no la pone el test: la pone el ARNÉS, con un UPDATE cuyas columnas deriva por
  // su cuenta (`snakeCase(campo)`) mientras el reclamo las lee por el `@Column` de la entidad.
  // Si las dos derivaciones se separan, el UPDATE afecta a CERO filas **sin fallar**, el barrido
  // no encuentra nada y el escenario del rescate pasa en verde sin haber atascado nada. Cada
  // mitad es correcta por su cuenta; lo que no existe es el par. Esto es lo único que lo ve.
  if (rescue && harness) {
    tests.push(`
    @Test
    void elArnesAtascaLaFilaYElRescateSeLaLleva() {
        UUID id = fila(${constant(rescue.from[0])}, Instant.now(), Instant.now());
        int filas = ejecuta(${javaLiteral(harness.stall)} + ${javaLiteral(harness.uuidPrefix)} + id + ${javaLiteral(harness.uuidSuffix)});
        assertEquals(1, filas, "el UPDATE del arnés no tocó la fila: sus columnas no son las del reclamo");

        var reclamadas = adaptador.${rescue.method}();

        assertEquals(1, reclamadas.size(), "el arnés atascó la fila pero el rescate no la encuentra");
        assertEquals(${constant(rescue.to)}, jpa.findById(id).orElseThrow().${statusGetter}(), "no la movió");
    }

    @Test
    void elArnesPoneEnVueloYAhiElRescateNoToca() {
        // La otra mitad del helper, y la que hace fallable al escenario: si el reloj «a ahora»
        // no fuera distinto del rancio, putInFlight y stallInFlight serían el mismo helper y
        // la cota temporal dejaría de estar probada por nadie.
        UUID id = fila(${constant(rescue.from[0])}, Instant.now(), Instant.now());
        int filas = ejecuta(${javaLiteral(harness.fresh)} + ${javaLiteral(harness.uuidPrefix)} + id + ${javaLiteral(harness.uuidSuffix)});
        assertEquals(1, filas, "el UPDATE del arnés no tocó la fila");

        var reclamadas = adaptador.${rescue.method}();

        assertTrue(reclamadas.isEmpty(), "el rescate se llevó una fila que el arnés acaba de poner en vuelo");
    }

    @Test
    void elContadorDeSinRelojDelArnesDiscrimina() {
        // Con una sin reloj, una con reloj y una en cola tiene que dar exactamente 1. Un
        // predicado que devolviera siempre cero pasaría todos los escenarios del rescate sin ver
        // el defecto para el que existe.
        fila(${constant(rescue.from[0])}, null, Instant.now());
        fila(${constant(rescue.from[0])}, Instant.now(), Instant.now());
        fila(${constant(queue ? queue.from[0] : rescue.to)}, null, Instant.now());

        assertEquals(1L, cuenta(${javaLiteral(harness.missingClock)}), "el contador del arnés no discrimina");
    }`);
  }

  if (guard) {
    tests.push(guardTests({
      guard,
      constant,
      documento: 'fila',
      lee: (id) => `jpa.findById(${id}).orElseThrow()`,
      statusGetter,
      guardStampGetter
    }));
  }

  return `package ${model.service.basePackage}.${PACKAGE_LEAF};

${imports.map((entry) => `import ${entry};`).join('\n')}

/**
 * El reclamo generado, ejercitado contra el motor real que levanta infra/.
 *
 * <p>Lo escribe scripts/claim-check.js desde src/lib/claim-probes.js: no es parte del proyecto
 * generado y no se versiona con él.
 *
 * <p><b>Sin transacción de test.</b> El adaptador reclama con {@code REQUIRES_NEW} —tiene que
 * confirmar antes de actuar— y una transacción de test envolviéndolo dejaría las filas sembradas
 * sin commitear, invisibles para la del reclamo. Se siembra con escrituras reales y se limpia
 * entre casos, que es además como ocurre en producción.
 */
@DataJpaTest(properties = {
        ${properties.join(',\n        ')}
})
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import(${adapterClass}.class)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class ${CLASS_NAME} {

    @Autowired
    private ${jpaRepoClass} jpa;

    @Autowired
    private ${portClass} adaptador;

    @Autowired
    private EntityManager em;

    private TransactionTemplate tx;

    @Autowired
    void transacciones(PlatformTransactionManager manager) {
        this.tx = new TransactionTemplate(manager);
    }

    @BeforeEach
    void limpia() {
        jpa.deleteAllInBatch();
    }

    /** Ejecuta el SQL del arnés tal cual y devuelve cuántas filas tocó. */
    private int ejecuta(String sql) {
        return tx.execute(status -> em.createNativeQuery(sql).executeUpdate());
    }

    /** Lo mismo para un contador. */
    private long cuenta(String sql) {
        return tx.execute(status -> ((Number) em.createNativeQuery(sql).getSingleResult()).longValue());
    }

    /** Una fila en el estado y con el reloj que pide el caso. */
    private UUID fila(${enumType} estado, Instant reloj, Instant creada) {
        ${jpaClass} row = new ${jpaClass}();
        row.setId(UUID.randomUUID());
        row.${statusSetter}(estado);${clockSetter ? `
        row.${clockSetter}(reloj);` : ''}
${orderSetter ? `        row.${orderSetter}(creada);` : `        // ${orderField} no es un campo sembrable: el lote se ordena por id`}
${requiredLiterals(scenarios, clockField, orderField).join('\n')}
        return jpa.saveAndFlush(row).getId();
    }
${tests.join('\n')}
}
`;
}
