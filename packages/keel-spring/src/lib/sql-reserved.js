// Palabras reservadas SQL: un nombre de campo del diseño (primary, order, user,
// value…) se convierte en nombre de columna literal, y sin quoting el DDL que
// genera Hibernate no compila — la tabla nunca se crea y toda operación que la
// toque devuelve 500.
//
// La lista es la UNIÓN de las reservadas de los seis dialectos soportados
// (postgresql, mysql, mariadb, oracle, sqlserver), porque el mismo diseño se
// genera para cualquiera de ellos y el nombre de columna no puede depender del
// que se elija en el cuestionario.
//
// El quoting se emite con backticks: Hibernate los traduce al carácter de
// quoting del dialecto de destino (" en PostgreSQL y Oracle, ` en MySQL,
// [] en SQL Server), así que el identificador del diseño se conserva tal cual y
// el resultado es portable.

// La lista vive en keel-core/gen (relational.js): el mismo diseño se genera con keel-spring o con
// keel-nest, y el nombre de columna no puede depender del generador más que del motor.
import { isReservedSqlWord, quoteIdentifierFor } from 'keel-core/gen/relational';

export function isReserved(name) {
  return isReservedSqlWord(name);
}

/**
 * Nombre de identificador listo para un @Column/@Table/@JoinColumn: entre
 * backticks si choca con una palabra reservada, tal cual si no.
 */
export function quoteIdentifier(name) {
  return isReserved(name) ? `\`${name}\`` : name;
}

// El carácter de cita REAL de cada motor, para el SQL escrito a mano (el appendix de índices
// condicionados): ahí no hay Hibernate que traduzca el backtick. Vive en keel-core/gen.
export { quoteIdentifierFor };
