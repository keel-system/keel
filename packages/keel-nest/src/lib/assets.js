import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Assets del generador: fuente neutral del conocimiento del proyecto generado. Nada de esto se
// copia al workspace de diseño.
export const assetsDir = path.join(packageRoot, 'assets');

export const TECH = 'nest';
export const SKILL = 'keel-generate-nest';

// Versiones del DSL keel que este generador sabe mapear. La misma que keel-spring: el método
// soporta una sola, y dos generadores que aceptaran versiones distintas no podrían recibir el
// mismo diseño.
export const SUPPORTED_DSL = ['2.20'];

// Stack del proyecto generado (un solo sitio para actualizarlo). Verificadas el 2026-10-06 contra
// el registro de npm y contra la plantilla ESM de `nest new` (@nestjs/schematics 12.0.6), que es
// la referencia de lo que Nest considera un proyecto bien formado:
//   · NestJS 12 publica sus paquetes SOLO como ESM y pide Node 20.19+ o 22.12+ para ejecutar;
//   · la CLI de Nest 12 trabaja con TypeScript ~6.0 (TS 7 es el compilador nativo y la CLI aún no
//     lo declara);
//   · los proyectos ESM usan Vitest: Jest solo carga los paquetes de Nest 12 desde Node 24.9;
//   · la plataforma HTTP es Fastify (@nestjs/platform-fastify), no Express: más rendimiento y un
//     único punto de lectura y escritura de JSON, que es donde se cumple el contrato del cable.
export const NODE_VERSION = '24';
export const NODE_ENGINE = '>=22.12';
export const NEST_VERSION = '^12.1.2';
export const NEST_CLI_VERSION = '^12.0.8';
export const NEST_SCHEMATICS_VERSION = '^12.0.6';
export const REFLECT_METADATA_VERSION = '^0.2.2';
export const RXJS_VERSION = '^7.8.2';
export const YAML_VERSION = '^2.9.1';
export const TYPESCRIPT_VERSION = '~6.0.2';
// Vitest 5 y no la 4 que trae la plantilla de `nest new`: con la 4, npm resuelve la última Vite, cuyas
// peers opcionales ya piden Vitest 5, y npm 10 revienta resolviéndolas («Cannot read properties of
// null (reading 'edgesOut')»). Vitest 5 declara Vite como peer, así que va explícita.
export const VITEST_VERSION = '^5.0.3';
export const VITE_VERSION = '^8.3.3';
export const TYPES_NODE_VERSION = '^24.0.0';
// Decimales exactos: el contrato del cable exige conservar la escala (Decimal de domain/support).
export const DECIMAL_JS_VERSION = '^10.6.0';
// Los tipos de Fastify (FastifyRequest, FastifyReply) en los controladores y el filtro de errores: la
// misma línea que trae @nestjs/platform-fastify 12, declarada para no depender de que npm la eleve.
export const FASTIFY_VERSION = '^5.12.5';
// La frontera hexagonal como regla ejecutable (check:architecture). La 18 pide Node 22+ y lee
// TypeScript con el compilador del propio proyecto.
export const DEPENDENCY_CRUISER_VERSION = '^18.5.0';
// Persistencia relacional (incremento 6), verificadas el 2026-10-06 contra el registro de npm:
// TypeORM 1.x (la 0.3 queda como `legacy`) y un driver por motor, el que TypeORM carga por su tipo.
export const TYPEORM_VERSION = '^1.1.1';
export const PG_VERSION = '^8.23.1';
export const MYSQL2_VERSION = '^3.24.5';
// La persistencia documental (incremento 12): el driver oficial de MongoDB, sin ODM —el mapeo es explícito—.
export const MONGODB_VERSION = '^7.7.0';
// El correo saliente (incremento 12e): nodemailer para SMTP (trae sus tipos) y Handlebars para las plantillas.
export const NODEMAILER_VERSION = '^10.0.10';
export const HANDLEBARS_VERSION = '^4.7.9';
// La caché de lectura (incremento 13f): el cliente oficial de Redis, solo el núcleo (sin los módulos de Redis Stack).
// También habla con Valkey. La 6 cambió el plazo por defecto de cada orden (5 s): el adaptador fija el suyo.
export const REDIS_CLIENT_VERSION = '^6.2.1';
// Seguridad (incremento 8), verificada el 2026-10-06 contra el registro de npm: la validación del JWT
// contra el JWKS del proveedor (firma, caducidad, emisor). Sin dependencias y sin Passport: la regla
// de cada ruta la evalúa un hook de la entrada HTTP con el plan neutral de keel-core.
export const JOSE_VERSION = '^6.2.12';
// Mensajería (incremento 9), verificada el 2026-10-07 contra el registro de npm y su documentación: amqplib 2
// trae sus tipos y la reconexión con `setup` (que vuelve a declarar la topología en cada reconexión).
export const AMQPLIB_VERSION = '^2.2.0';
// Kafka (incremento 9f), verificado el 2026-10-07: el cliente de Confluent sobre librdkafka, con API compatible
// con KafkaJS y binarios precompilados (también para Windows). kafkajs no publica desde 2023, y
// @platformatic/kafka exige Node >= 22.22, por encima del 22.12 que promete el proyecto generado.
export const KAFKA_JAVASCRIPT_VERSION = '^1.10.1';
// SNS/SQS (incremento 9g), verificado el 2026-10-07: el SDK v3 de AWS, un paquete por servicio (Node >= 20).
export const AWS_SDK_VERSION = '^3.1147.0';
// El reloj (incremento 10b), verificado el 2026-10-07: `cron` 4.4, el que usa por dentro @nestjs/schedule, a
// pelo. Las expresiones salen de la configuración en el arranque y no de un decorador, así que el registro de
// @nestjs/schedule no aporta nada; `waitForCompletion` es la semántica del @Scheduled de Spring (no se solapa
// consigo mismo) y `stop()` espera a la pasada en vuelo, que es lo que pide el apagado ordenado.
export const CRON_VERSION = '^4.4.0';

export function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
}
