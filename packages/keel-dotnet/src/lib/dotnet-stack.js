// Los paquetes NuGet que puede emitir keel-dotnet, cada uno con su versión EXACTA y su licencia (SPDX), y
// la regla que los vigila: solo licencias permisivas, y nunca un paquete que haya pasado a licencia
// comercial. Es una restricción del proyecto (PLAN-KEEL-DOTNET.md § 1.6), escrita en código para que no
// dependa de que alguien se acuerde: `test/licenses.test.js` la comprueba sobre esta tabla, y
// `npm run cs-check` sobre lo que NuGet resuelve de verdad, transitivas incluidas.
//
// La licencia de cada entrada se leyó del catálogo de nuget.org (`licenseExpression`) el día que se
// fijó la versión; subir una versión obliga a volver a leerla.

/** Licencias admitidas: permisivas, sin obligación de publicar el código del servicio. */
export const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'PostgreSQL', 'MS-PL', 'Zlib', 'ISC'];

/**
 * Lo que pasó a licencia comercial, por nombre y desde qué versión mayor. Una versión anterior seguiría
 * siendo libre, pero no se emite: quedarse en la última libre de algo que ya no se mantiene es otra deuda.
 */
export const COMMERCIAL_PACKAGES = [
  { id: 'MediatR', since: 13, why: 'licencia comercial desde la 13 (2025)' },
  { id: 'AutoMapper', since: 15, why: 'licencia comercial desde la 15 (2025)' },
  { id: 'MassTransit', since: 9, why: 'licencia comercial desde la 9' },
  { id: 'FluentAssertions', since: 8, why: 'gratis solo para uso no comercial desde la 8 (Xceed)' },
  { id: 'Duende.IdentityServer', since: 0, why: 'licencia comercial' },
  { id: 'SixLabors.ImageSharp', since: 0, why: 'licencia dividida (Six Labors Split License)' },
  { id: 'QuestPDF', since: 0, why: 'licencia comercial por encima de un umbral de ingresos' },
  { id: 'EPPlus', since: 5, why: 'licencia comercial desde la 5' },
  { id: 'itext', since: 0, why: 'AGPL o comercial' },
  { id: 'itext7', since: 0, why: 'AGPL o comercial' }
];

/**
 * Los paquetes, por su id NuGet. `use` dice para qué está; `license` es el `licenseExpression` del
 * catálogo para esa versión. Verificado el 2026-10-13.
 */
export const PACKAGES = {
  // La configuración por perfiles (config/application.yaml + config/parameters/<perfil>/): el mismo
  // formato en disco que los otros dos generadores.
  YamlDotNet: { version: '18.1.0', license: 'MIT', use: 'lectura de la configuración YAML' },
  // Pruebas: xUnit v3 sobre Microsoft.Testing.Platform (trae xunit.v3.mtp-v2), y el host de prueba de
  // ASP.NET Core para pedir las rutas del servidor sin abrir un puerto.
  'xunit.v3': { version: '4.0.2', license: 'Apache-2.0', use: 'pruebas' },
  'Microsoft.AspNetCore.Mvc.Testing': { version: '10.0.13', license: 'MIT', use: 'pruebas del servidor en memoria' },
  // La persistencia relacional (incremento 6): EF Core y su proveedor de PostgreSQL, que trae Npgsql. La licencia
  // de Npgsql es la de PostgreSQL (permisiva, tipo MIT). Verificadas el 2026-10-13.
  'Microsoft.EntityFrameworkCore': { version: '10.0.13', license: 'MIT', use: 'persistencia relacional (ORM)' },
  'Npgsql.EntityFrameworkCore.PostgreSQL': { version: '10.0.3', license: 'PostgreSQL', use: 'proveedor de PostgreSQL para EF Core' },
  // Fijado a mano: el proveedor de Npgsql lo pide como `[10.0.4, 11)` y NuGet resuelve la MÍNIMA, mientras EF Core y
  // su paquete de diseño traen la 10.0.13. Sin fijarlo, el proyecto mezclaba las dos (MSB3277, medido).
  'Microsoft.EntityFrameworkCore.Relational': { version: '10.0.13', license: 'MIT', use: 'EF Core relacional (fijado a la versión de EF Core)' },
  // Solo en tiempo de diseño (PrivateAssets: no viaja con el servicio): lo que usa `dotnet ef` para generar las
  // migraciones desde el modelo.
  'Microsoft.EntityFrameworkCore.Design': { version: '10.0.13', license: 'MIT', use: 'generación de migraciones (tiempo de diseño)' },
  // La seguridad con token (incremento 8): validar el JWT contra el JWKS del proveedor. Trae Microsoft.IdentityModel.Tokens.
  // Sin el handler JwtBearer de ASP.NET Core, que decide después de enrutar (scaffold/security.js). Verificada el 2026-10-14.
  'Microsoft.IdentityModel.JsonWebTokens': { version: '8.23.0', license: 'MIT', use: 'validación del JWT (capa security)' },
  // La mensajería sobre RabbitMQ (incremento 9): el cliente oficial, con licencia doble a elegir. Verificada el 2026-10-14.
  'RabbitMQ.Client': { version: '7.2.2', license: 'Apache-2.0 OR MPL-2.0', use: 'conexión con RabbitMQ (capa messaging)' },
  // La mensajería sobre Kafka (incremento 9f): el cliente oficial de Confluent sobre librdkafka (nativo, por
  // librdkafka.redist, ver VERIFIED_LICENSES). Fijado a la versión de librdkafka que trae. Verificada el 2026-10-14.
  'Confluent.Kafka': { version: '2.15.1', license: 'Apache-2.0', use: 'conexión con Kafka (capa messaging)' },
  // La mensajería sobre SNS/SQS (incremento 9g): el SDK oficial de AWS para .NET (v4), las versiones con dos semanas o
  // más el día que se fijaron (el SDK publica casi a diario). Los dos piden AWSSDK.Core [4.0.102.6, 5): NuGet resuelve
  // la mínima, Apache-2.0 también. Verificadas el 2026-10-14.
  'AWSSDK.SimpleNotificationService': { version: '4.0.100.15', license: 'Apache-2.0', use: 'publicación en SNS (capa messaging)' },
  'AWSSDK.SQS': { version: '4.0.100.14', license: 'Apache-2.0', use: 'consumo de SQS (capa messaging)' }
};

/**
 * Lo que NuGet resuelve y NO declara una licencia SPDX, solo una URL: leída a mano en su fuente, para una versión
 * EXACTA. Otra versión vuelve a no poder comprobarse (y cs-check sale en rojo) hasta que alguien la lea.
 */
export const VERIFIED_LICENSES = {
  // librdkafka (el driver nativo que usa Confluent.Kafka) es BSD-2-Clause, y su LICENSES.txt lista lo que incluye:
  // cJSON, hdrhistogram y pycrc (MIT), crc32c, nanopb y tinycthread (Zlib), lz4, queue y snappy (BSD), wingetopt
  // (ISC), la parte de OpenTelemetry (Apache-2.0) y fnv1a, murmur2 y regexp (dominio público, sin obligaciones).
  'librdkafka.redist': {
    version: '2.15.1',
    license: 'BSD-2-Clause AND MIT AND Zlib AND BSD-3-Clause AND ISC AND Apache-2.0',
    source: 'https://github.com/confluentinc/librdkafka/blob/v2.15.1/LICENSES.txt',
    verified: '2026-10-14'
  }
};

/** La licencia verificada a mano de un paquete y versión, o null. */
export function verifiedLicense(id, version) {
  const entry = Object.entries(VERIFIED_LICENSES).find(([known]) => known.toLowerCase() === String(id).toLowerCase())?.[1];
  return entry && entry.version === version ? entry.license : null;
}

/**
 * Las herramientas locales de .NET (`.config/dotnet-tools.json`), con la misma regla que los paquetes: versión exacta
 * y licencia permisiva. `dotnet tool restore` las instala en la versión fijada.
 */
export const TOOLS = {
  'dotnet-ef': { version: '10.0.13', license: 'MIT', command: 'dotnet-ef', use: 'migraciones de EF Core (dotnet ef)' }
};

/** Las versiones mayores de un id comercial que no se pueden emitir; null si el id no está vetado. */
export function commercialRule(id) {
  return COMMERCIAL_PACKAGES.find((rule) => rule.id.toLowerCase() === String(id).toLowerCase()) ?? null;
}

/**
 * Los problemas de licencia de un paquete y versión. Vacío si se puede emitir. `license` es la expresión
 * SPDX que declara el paquete (null si declara una URL o nada: entonces no se puede saber y se rechaza).
 */
export function licenseProblems({ id, version, license }) {
  const problems = [];
  const rule = commercialRule(id);
  if (rule && Number.parseInt(String(version), 10) >= rule.since) problems.push(`${id} ${version}: ${rule.why}`);
  if (!license) problems.push(`${id} ${version}: no declara licencia SPDX (solo una URL o nada): no se puede comprobar`);
  else if (!licenseAllowed(license)) problems.push(`${id} ${version}: licencia ${license}, fuera de ${ALLOWED_LICENSES.join(', ')}`);
  return problems;
}

/**
 * ¿Admite la expresión SPDX alguna licencia de la lista? Una disyunción (`MIT OR Apache-2.0`) deja elegir;
 * una conjunción (`MIT AND GPL-3.0`) obliga a todas, y se rechaza salvo que todas estén admitidas.
 */
export function licenseAllowed(expression) {
  const text = String(expression).replace(/[()]/g, ' ').trim();
  return text.split(/\s+OR\s+/).some((alternative) => alternative.split(/\s+AND\s+/).every((part) => ALLOWED_LICENSES.includes(part.trim())));
}
