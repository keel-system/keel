// Orquestador del scaffolding determinista de keel-nest: construye el modelo desde el diseño
// validado y renderiza todos los artefactos en services/<name>-nest/.
//
// El modelo es el MISMO que el de keel-spring (`buildModel` de keel-core/gen) con la proyección
// TypeScript, y la escritura es la misma (`materializeProject`): lo único de este paquete son los
// renderizadores de abajo.

import path from 'node:path';
import { buildModel } from 'keel-core/gen/model';
import { materializeProject } from 'keel-core/gen/materialize';
import { resolveStack } from 'keel-core/gen/stack';
import { listKeelDocs } from 'keel-core/gen/keel-docs';
import { checkGatewaySupport } from 'keel-core/gen/payment-gateways';
import { packageVersion } from '../lib/assets.js';
import { TS_PROJECTION } from '../lib/ts-projection.js';
import * as project from './project.js';
import * as config from './config.js';
import * as serviceParameters from './service-parameters.js';
import * as wire from './wire.js';
import * as application from './application.js';
import * as enums from './enums.js';
import * as valueTypes from './value-types.js';
import * as entities from './entities.js';
import * as ids from './ids.js';
import * as events from './events.js';
import * as exceptions from './exceptions.js';
import * as dtos from './dtos.js';
import * as mappers from './mappers.js';
import * as services from './services.js';
import * as mediator from './mediator.js';
import * as persistenceEntities from './persistence-entities.js';
import * as repositories from './repositories.js';
import * as persistenceRuntime from './persistence-runtime.js';
import * as documentPersistence from './document-persistence.js';
import * as schemaBaseline from './schema-baseline.js';
import * as requestIdempotency from './request-idempotency.js';
import * as messaging from './messaging.js';
import * as messagingStores from './messaging-stores.js';
import * as rabbitmq from './rabbitmq.js';
import * as kafka from './kafka.js';
import * as snssqs from './snssqs.js';
import * as httpClients from './http-clients.js';
import * as mail from './mail.js';
import * as payments from './payments.js';
import * as cache from './cache.js';
import * as storage from './storage.js';
import * as auditActor from './audit-actor.js';
import * as scheduling from './scheduling.js';
import * as purge from './purge.js';
import * as claim from './claim.js';
import * as reconciliationClaim from './reconciliation-claim.js';
import * as idempotencyCheck from './idempotency-check.js';
import * as domainGuardsCheck from './domain-guards-check.js';
import * as architecture from './architecture.js';
import * as restSupport from './rest-support.js';
import * as controllers from './controllers.js';
import * as security from './security.js';
import * as testCredential from './test-credential.js';
import * as apiTests from './api-tests.js';
import * as health from './health.js';
import * as appTests from './app-tests.js';
import * as infra from './infra.js';
import * as integrationTests from './integration-tests.js';
import * as readme from './readme.js';
import * as generatorDocs from './generator-docs.js';

// Orden de emisión. Cada módulo se gatea a sí mismo por lo que el modelo declara.
const GENERATORS = [
  project,
  // La frontera hexagonal, como regla ejecutable (npm run check:architecture).
  architecture,
  config,
  // Los parámetros de despliegue del servicio (service.parameters): el value object y su módulo.
  serviceParameters,
  wire,
  application,
  health,
  // Dominio (incremento 4): TypeScript puro, sin Nest ni persistencia.
  enums,
  valueTypes,
  entities,
  ids,
  events,
  exceptions,
  // Aplicación: mensajes, handlers, DTOs y mappers; el mediator que los despacha y el módulo que
  // los cablea (este necesita saber qué mappers hay).
  dtos,
  mappers,
  services,
  // Persistencia relacional (incremento 6): las entidades TypeORM sobre el esquema neutral, los
  // puertos con sus adaptadores y el DataSource con su transacción.
  persistenceEntities,
  repositories,
  persistenceRuntime,
  // Persistencia documental (incremento 12): el cliente de MongoDB, la transacción, los índices del diseño y
  // los mismos archivos de errores y módulo que la relacional; el adaptador de cada raíz sale de repositories.js.
  documentPersistence,
  // La idempotencia de petición: el registro, su firma y su contexto (la misma tabla que keel-spring).
  requestIdempotency,
  // La mensajería (incremento 9): la envoltura, los eventos de integración, el puente, los mensajes de
  // suscripción, el outbox con su relay, el registro de procesados y la conexión con el broker (RabbitMQ, Kafka o SNS/SQS).
  messaging,
  messagingStores,
  rabbitmq,
  kafka,
  snssqs,
  // Los clientes HTTP salientes (incremento 11b): puerto en domain/clients, adaptador sobre fetch con el
  // retry, el circuito y el fallback de la política neutral, DTOs wire y mapper de anticorrupción.
  httpClients,
  // El correo saliente (incremento 12e): mensaje, puertos, adaptador SMTP y renderizador, enteros (como keel-spring).
  mail,
  // Los cobros con pasarela (incremento 13): la parte neutra y el adaptador y el verificador de la pasarela del stack.
  payments,
  // La caché de lectura (incremento 13f): el puerto, las cachés del diseño, sus lectores, el adaptador sobre
  // Redis/Valkey y qué vacía cada operación.
  cache,
  // El almacenamiento de binarios (incremento 13g): el contrato (puerto, política con la firma del contenido,
  // buckets), su configuración, el módulo con el stub del adaptador S3 y la lectura de la entrada multipart.
  storage,
  // La autoría de las escrituras (incremento 13h): quién crea y modifica, con la regla del AuditorAware de keel-spring.
  auditActor,
  // El reloj (incremento 10b): los schedulers de las operaciones con `schedule` y las purgas por lotes de las
  // tablas del generador.
  scheduling,
  purge,
  // Los reclamos de barrido (incremento 10c): la configuración de los lotes y los plazos; los métodos van en
  // el puerto y el adaptador de cada raíz (repositories.js).
  claim,
  // El reclamo de la reconciliación (incremento 11c): reconciliation_claim, su tienda y los números de cada barrido.
  reconciliationClaim,
  // El gate de idempotencia y compensación (incremento 10d): infra/check-idempotency.sh, con el motor de keel-core.
  idempotencyCheck,
  // El baseline de migraciones: cómo se exporta y cómo se demuestra (lo usa el pase de calidad).
  schemaBaseline,
  { generate: (model) => mediator.generate(model, { mappers: mappers.mapperClasses(model), payments: payments.paymentApplicationClasses(model) }) },
  // API REST (incremento 5): correlación, ErrorResponse, lectura de peticiones, filtro de errores y
  // un controlador por grupo.
  restSupport,
  controllers,
  // La seguridad (incremento 8): el hook de la entrada HTTP con el plan de acceso neutral, el JWT, las
  // claves, CORS, la identidad del llamante y el alcance por recurso.
  security,
  // La credencial con la que las pruebas del perfil test pasan la autorización.
  testCredential,
  domainGuardsCheck,
  appTests,
  apiTests,
  // La infraestructura de prueba (neutral, keel-core/gen) y el arnés de integración que puntúa los
  // escenarios FL-* contra ella (incremento 7).
  infra,
  integrationTests,
  readme,
  generatorDocs
];

/**
 * Todo lo que hay que resolver para generar, SIN tocar disco: el stack normalizado, el modelo con
 * sus avisos y el árbol de archivos ya renderizado en memoria. Lo comparten `build` (para escribir)
 * y `check` (para no escribir): si se duplicara, las dos pasadas opinarían distinto del mismo diseño.
 */
export function planService({ manifest, layers, workspace, stack = null }) {
  const resolved = resolveStack(stack, layers);
  // La pasarela elegida tiene que cubrir lo que el diseño exige (la matriz neutral de keel-core). Aquí y no solo en
  // build, para que NINGÚN camino genere un adaptador a medias. La misma puerta que keel-spring.
  if (resolved.paymentGateway) {
    const { errors } = checkGatewaySupport(layers, resolved.paymentGateway);
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }
  const model = buildModel({ manifest, layers, stack: resolved, projection: TS_PROJECTION });
  model.stack = resolved;
  // Contratos de /keel-docs presentes en el workspace: build los copia a docs/ del proyecto.
  model.docs = listKeelDocs(workspace, model.service.name);
  return { model, stack: resolved, files: GENERATORS.flatMap((generator) => generator.generate(model)) };
}

export function scaffoldService({
  manifest,
  layers,
  workspace,
  force = false,
  stack = null,
  mode = null,
  prune = false,
  readiness = null,
  acceptedUnready = false
}) {
  const { model, files } = planService({ manifest, layers, workspace, stack });
  const outDir = path.join('services', model.service.projectName);
  const projectDir = path.join(workspace, outDir);
  const written = materializeProject({
    files,
    projectDir,
    generator: `keel-nest@${packageVersion()}`,
    force,
    mode,
    prune,
    readiness,
    acceptedUnready
  });
  return {
    outDir: outDir.split(path.sep).join('/'),
    projectDir,
    warnings: model.warnings,
    stack: model.stack,
    docs: model.docs,
    ...written
  };
}
