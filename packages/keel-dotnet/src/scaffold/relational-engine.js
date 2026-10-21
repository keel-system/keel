// El MOTOR relacional del diseño y lo poco que cambia entre los dos que keel-dotnet genera: PostgreSQL (incremento 6) y
// MySQL. Todo lo demás —tablas, columnas, nombres de constraint, errores del contrato— es de keel-core/gen y no
// distingue motor; lo de aquí es cómo se habla con cada uno desde EF Core y desde el SQL escrito a mano.
//
// El proveedor de MySQL es Microting.EntityFrameworkCore.MySql (MIT, el fork de Pomelo que publica para EF Core 10) sobre
// MySqlConnector (MIT). El de Oracle (MySql.EntityFrameworkCore) es GPL-2.0 y no lo admite dotnet-stack.js.
//
// Dos decisiones que no son obvias:
//   · el uuid va en binary(16) con los bytes EN EL ORDEN DEL TEXTO (`GuidFormat=Binary16`, el UUID_TO_BIN(x) sin su
//     segundo argumento): el de keel-spring y keel-nest y el que asume el `uuidLiteral` del catálogo con el que el arnés
//     escribe SQL a mano. El Guid de .NET serializa con orden mixto: con cualquier otro formato, el mismo id se guarda
//     con otros bytes y un WHERE del arnés devuelve vacío sin fallar;
//   · la versión del servidor es FIJA y no `ServerVersion.AutoDetect`: `dotnet ef` y la prueba del modelo construyen el
//     modelo sin base, y AutoDetect conecta.

import { needsReadCommitted } from 'keel-core/gen/infra-catalog';

/** El motor relacional del diseño: el que pide el stack, o PostgreSQL. */
export function relationalEngine(model) {
  return model.stack?.database === 'mysql' ? 'mysql' : 'postgresql';
}

export function usesMySql(model) {
  return relationalEngine(model) === 'mysql';
}

/** La versión de MySQL que EF da por supuesta: la imagen del catálogo es `mysql:8.0`, y SKIP LOCKED pide 8.0.1. */
const MYSQL_SERVER_VERSION = 'new MySqlServerVersion(new Version(8, 0, 36))';

/** El formato del uuid en MySQL: binary(16) big-endian, el de keel-spring y keel-nest. */
export const MYSQL_GUID_FORMAT = 'Binary16';

/** El paquete del proveedor de EF Core de cada motor (dotnet-stack.js lleva su versión y su licencia). */
export const PROVIDER_PACKAGES = {
  postgresql: ['Npgsql.EntityFrameworkCore.PostgreSQL'],
  mysql: ['Microting.EntityFrameworkCore.MySql', 'MySqlConnector']
};

/** El namespace del driver ADO.NET de cada motor: sus excepciones y su constructor de cadenas de conexión. */
export function driverNamespace(model) {
  return usesMySql(model) ? 'MySqlConnector' : 'Npgsql';
}

/**
 * La llamada `UseNpgsql(...)` / `UseMySql(...)` de un DbContextOptionsBuilder, con la cadena de conexión (expresión C#)
 * y, si lo hay, el lambda de opciones del proveedor (`provider => provider…`).
 */
export function useProvider(model, connectionString, configure = null) {
  const args = [connectionString, ...(usesMySql(model) ? [MYSQL_SERVER_VERSION] : []), ...(configure ? [configure] : [])];
  // Un argumento que empieza en línea nueva no lleva el espacio tras la coma.
  const list = args.map((arg, index) => (index === 0 || arg.startsWith('\n') ? arg : ` ${arg}`)).join(',');
  return `${usesMySql(model) ? 'UseMySql' : 'UseNpgsql'}(${list})`;
}

/**
 * Una cadena de conexión que no conecta (diseño, prueba del modelo, perfil sin base). En MySQL lleva el formato del uuid:
 * el proveedor decide de ella el tipo de columna de un Guid.
 */
export function placeholderConnection(model, host) {
  return usesMySql(model) ? `Server=${host};Database=design_time;GuidFormat=${MYSQL_GUID_FORMAT}` : `Host=${host};Database=design_time`;
}

/** El alias de la columna que lee `SqlQuery<T>` (EF la busca por el nombre `Value`, con esa caja), dentro de un `$"…"`. */
export function valueAlias(model) {
  return usesMySql(model) ? 'AS `Value`' : 'AS \\"Value\\"';
}

/**
 * El pool del driver tal como lo publica su Meter, que es la única API de estadísticas de los dos: el nombre del Meter, los
 * instrumentos (conexiones por estado, máximo y peticiones esperando una conexión) y la etiqueta del panel. Los nombres
 * NO coinciden entre drivers: MySqlConnector sigue con la convención anterior (`connections`, en plural, y `state`). Con
 * un nombre equivocado la serie de saturación sale siempre a 0 y su alerta no dispara. Medidos con un MeterListener.
 */
export const POOL_METERS = {
  postgresql: {
    meter: 'Npgsql',
    prefix: 'db.client.connection.',
    count: 'db.client.connection.count',
    max: 'db.client.connection.max',
    pending: 'db.client.connection.npgsql.pending_requests',
    stateTag: 'db.client.connection.state',
    countObservable: true,
    label: 'npgsql',
    measured: 'Npgsql 10.0.3, el 2026-10-18'
  },
  mysql: {
    meter: 'MySqlConnector',
    prefix: 'db.client.connections.',
    count: 'db.client.connections.usage',
    max: 'db.client.connections.max',
    pending: 'db.client.connections.pending_requests',
    stateTag: 'state',
    countObservable: false,
    label: 'mysqlconnector',
    measured: 'MySqlConnector 2.6.2, el 2026-10-20'
  }
};

export function poolMeter(model) {
  return POOL_METERS[relationalEngine(model)];
}

/**
 * ¿Los reclamos (SKIP LOCKED) piden READ COMMITTED? En MySQL sí: en REPEATABLE READ una lectura con bloqueo toma
 * también los HUECOS entre claves y frena los INSERT de filas nuevas hasta el lock wait timeout (needsReadCommitted de
 * keel-core, la misma regla que keel-spring y keel-nest).
 */
export function claimIsolation(model) {
  return needsReadCommitted(relationalEngine(model)) ? 'IsolationLevel.ReadCommitted' : 'null';
}
