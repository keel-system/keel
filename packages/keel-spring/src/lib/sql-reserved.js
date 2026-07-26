// Palabras reservadas SQL: un nombre de campo del diseño (primary, order, user,
// value…) se convierte en nombre de columna literal, y sin quoting el DDL que
// genera Hibernate no compila — la tabla nunca se crea y toda operación que la
// toque devuelve 500.
//
// La lista es la UNIÓN de las reservadas de los seis dialectos soportados
// (postgresql, mysql, mariadb, oracle, sqlserver, h2), porque el mismo diseño se
// genera para cualquiera de ellos y el nombre de columna no puede depender del
// que se elija en el cuestionario.
//
// El quoting se emite con backticks: Hibernate los traduce al carácter de
// quoting del dialecto de destino (" en PostgreSQL/Oracle/H2, ` en MySQL,
// [] en SQL Server), así que el identificador del diseño se conserva tal cual y
// el resultado es portable.

const RESERVED = new Set(
  `absolute action add all allocate alter and any are array as asc assertion at authorization
   avg before begin between bigint binary bit blob boolean both breadth by call cascade cascaded
   case cast catalog char character check class clob close coalesce collate collation column
   commit condition connect connection constraint constraints contains continue convert
   corresponding count create cross cube current current_date current_path current_role
   current_time current_timestamp current_user cursor cycle data date day deallocate dec decimal
   declare default deferrable deferred delete depth deref desc describe descriptor deterministic
   diagnostics disconnect distinct do domain double drop dynamic each else elseif end end_exec
   equals escape except exception exec execute exists exit external extract false fetch filter
   first float for foreign found free from full function general get global go goto grant group
   grouping handler having hold hour identity if immediate in indicator initially inner inout
   input insensitive insert int integer intersect interval into is isolation iterate join key
   language large last lateral leading leave left level like limit local localtime localtimestamp
   locator loop lower map match max member merge method min minute modifies module month
   multiset names national natural nchar nclob new next no none not null nullif numeric object
   of offset old on only open option or order ordinality out outer output over overlaps pad
   parameter partial partition path position precision prepare preserve primary prior privileges
   procedure public range read reads real recursive ref references referencing relative release
   repeat resignal restrict result return returns revoke right role rollback rollup routine row
   rows savepoint schema scope scroll search second section select sensitive session session_user
   set sets signal similar size smallint some space specific specifictype sql sqlexception
   sqlstate sqlwarning start state static submultiset substring sum symmetric system system_user
   table tablesample temporary then time timestamp timezone_hour timezone_minute to trailing
   transaction translate translation treat trigger trim true under undo union unique unknown
   unnest until update upper usage user using value values varchar varying view when whenever
   where while window with within without work write year zone`
    .split(/\s+/)
    .filter(Boolean)
);

export function isReserved(name) {
  return RESERVED.has(String(name).toLowerCase());
}

/**
 * Nombre de identificador listo para un @Column/@Table/@JoinColumn: entre
 * backticks si choca con una palabra reservada, tal cual si no.
 */
export function quoteIdentifier(name) {
  return isReserved(name) ? `\`${name}\`` : name;
}
