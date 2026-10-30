// El MOTOR relacional del diseño y lo poco que cambia entre los dos que keel-go genera: PostgreSQL (incremento 6) y
// MySQL (6d). Todo lo demás —tablas, columnas, nombres de constraint, errores del contrato— es de keel-core/gen y no
// distingue motor; lo de aquí es cómo se le habla a cada uno desde SQL escrito a mano sobre database/sql.
//
// Cada motor tiene su PAQUETE (`internal/infrastructure/postgres` o `internal/infrastructure/mysql`), como el resto de
// la infraestructura: un paquete por tecnología (PLAN-KEEL-GO.md § 2). Lo de encima (el arranque, los casos de uso) no
// distingue: los dos paquetes exportan los mismos nombres (Settings, Open, Migrate, Transactions, New<Raíz>Repository).
//
// Tres decisiones que no son obvias:
//   · en MySQL el uuid va en binary(16) con los bytes EN EL ORDEN DEL TEXTO (el UUID_TO_BIN(x) sin su segundo
//     argumento): el de keel-spring, keel-nest y keel-dotnet y el que asume el `uuidLiteral` del catálogo. uuid.UUID es
//     un [16]byte en ese orden, pero su `Value()` es el TEXTO: un argumento uuid.UUID se escribiría como 36 caracteres
//     en una columna de 16 bytes. Lo convierte la conexión del adaptador (`bind`), en un solo sitio, para todo SQL;
//   · MySQL no tiene arrays: el lote (`= ANY($1::uuid[])` en PostgreSQL) es un `IN (?, ?, …)` con un parámetro por
//     valor, compuesto en Go (`inList`), nunca con los valores dentro del texto;
//   · el tope de la transacción en MySQL va en la SESIÓN, al abrir cada conexión (`innodb_lock_wait_timeout` para la
//     espera de un bloqueo y `max_execution_time` para una lectura), y no dentro de la transacción como el
//     `SET LOCAL statement_timeout` de PostgreSQL: MySQL no tiene un tope por sentencia para las escrituras.

import { quoteIdentifierFor } from '@keel-system/keel-core/gen';

/** El motor relacional del diseño: el que pide el stack, o PostgreSQL. */
export function relationalEngine(model) {
  return model?.stack?.database === 'mysql' ? 'mysql' : 'postgresql';
}

export function usesMySql(model) {
  return relationalEngine(model) === 'mysql';
}

/** El paquete del adaptador de cada motor, bajo internal/infrastructure. */
export const STORE_PACKAGES = { postgresql: 'postgres', mysql: 'mysql' };

/** El nombre legible del motor, para la prosa de los comentarios. */
export const ENGINE_LABELS = { postgresql: 'PostgreSQL', mysql: 'MySQL' };

/** El directorio del paquete del adaptador del motor del diseño. */
export function storeDir(model) {
  return `internal/infrastructure/${STORE_PACKAGES[relationalEngine(model)]}`;
}

/**
 * El dialecto del SQL que escriben los adaptadores: cómo se cita un identificador reservado, cómo se escribe el
 * parámetro n (1-based) y el nombre del motor.
 */
export function sqlDialect(model) {
  const engine = relationalEngine(model);
  return {
    engine,
    label: ENGINE_LABELS[engine],
    mysql: engine === 'mysql',
    quote: (name) => quoteIdentifierFor(engine, name),
    param: engine === 'mysql' ? () => '?' : (n) => `$${n}`
  };
}
