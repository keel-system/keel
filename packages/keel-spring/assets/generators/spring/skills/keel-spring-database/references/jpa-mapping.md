# Mapeo JPA estructural — extender el baseline de build

Build deja un baseline **correcto para el caso común** (escalares, enums, `@Id`,
`@Column` con nullable/unique/length/precision, `@Table` con índices y clave
natural, auditoría createdAt/updatedAt, value object de un nivel aplanado a
columnas con prefijo, colecciones de valores sin identidad —`list`— como tablas
de elementos con su `@Embeddable`, composición interna de agregado con
`@JoinColumn`, referencia por id entre agregados). Esta referencia cubre lo que build **no**
resuelve y que el diseño puede exigir: aquí **ajustas/extiendes** el código
generado, sin reescribir el patrón puerto + adaptador ni el mapeo `toDomain`/`toJpa`.

Regla de oro: build nunca deja código que no compila. Donde no puede decidir,
deja un `// TODO (agente): …`. Tu trabajo es (1) resolver esos TODO y (2) aplicar
lo de abajo cuando `specs/persistence.keel.yaml` + `domain.keel.yaml` lo pidan.
Antes de tocar tipos de columna del dialecto, lee `references/dialects/<database>.md`.

## 1. Relaciones

### Qué dejó build
- **Relación interna al agregado** (misma raíz): `@OneToMany(cascade = ALL,
  orphanRemoval = true)` **con `@JoinColumn(name = "<owner>_id")`** (unidireccional
  con FK en la tabla hija, sin join table) para to-many; `@ManyToOne`/`@OneToOne`
  con `@JoinColumn(name = "<relation>_id")` para to-one.
- **Relación hacia otro agregado** `many-to-one`/`one-to-one`: **columna `UUID
  <relation>Id`**, sin asociación navegable (respeta la frontera de agregado de
  `constitution.md`).

### Cuándo intervienes
- **Bidireccionalidad**: si necesitas navegar la relación en ambos sentidos,
  añade el lado inverso y marca el dueño con `mappedBy`. Regla: el dueño es quien
  tiene la FK; el lado `mappedBy` **no** lleva `@JoinColumn`. Un solo `@JoinColumn`
  por relación (no lo dupliques en ambos lados: doble gestión de FK).
- **Fetch**: mantén `LAZY` (default de to-many; fuérzalo en `@ManyToOne`/`@OneToOne`
  con `fetch = FetchType.LAZY` si la asociación no se usa siempre). Con
  `open-in-view: false`, el fetch que falte se resuelve en el **repositorio** con
  `JOIN FETCH` o `@EntityGraph`, nunca abriendo la vista ni poniendo EAGER a ciegas
  (ver `references/configuration.md`, sección N+1). No pongas EAGER para "arreglar"
  una `LazyInitializationException`.
- **Relación to-many entre agregados** (`one-to-many`/`many-to-many` hacia otra
  raíz): build **no la genera** (emite un warning). Modélala tú **sin** violar la
  frontera de agregado:
  - Preferente: colección de ids (`@ElementCollection` de `UUID`, o una tabla
    puente propia mapeada como entidad JPA con su repositorio) — el otro agregado
    se referencia por id, no por asociación navegable profunda.
  - Evita `@ManyToMany` directo entre dos raíces con cascade: acopla ciclos de
    vida de agregados distintos. Si el negocio lo exige, tabla puente explícita.

## 2. Value objects

### Qué dejó build
- VO compuesto de **un nivel escalar** (campo suelto) → columnas aplanadas con
  prefijo (`<field>_<sub>`), reconstruido en `toDomain`/`toJpa`. El VO de dominio
  es un `record` puro en `domain/valueobject`.
- **Colección de VOs de un nivel** (`type: <VO>, list: true`) → completa:
  `@ElementCollection List<<VO>Jpa>` con `@CollectionTable(name = "<entidad>_<campo>")`,
  el `@Embeddable <VO>Jpa` (espejo de columnas) y el mapeo bidireccional en el
  adaptador. **No intervienes** salvo que el VO tenga un VO anidado dentro.
- **Colección de escalares/enums** (`type: string|uuid|<Enum>, list: true`) →
  completa: tabla de elementos con `@Column` (o `@Enumerated` para enum). No intervienes.

### Cuándo intervienes
- **VO anidado** (VO dentro de VO), suelto o dentro de una colección: build deja
  un `// TODO (agente)` en la `XxxJpa` (y en el `<VO>Jpa` embeddable) y en el
  adaptador. Resuélvelo con `@Embeddable` en el VO interno + `@Embedded`
  (o `@Embedded @AttributeOverrides` para renombrar columnas).
- **Promover el aplanado a `@Embeddable`**: puedes convertir el aplanado de build
  en un `@Embeddable` reutilizable si varias entidades comparten el mismo VO. Es
  opcional; el aplanado por columnas ya es válido para el caso de un nivel.
- Mantén el VO de **dominio** como record puro (sin JPA): la anotación JPA vive en
  el espejo `XxxJpa` o en una clase `@Embeddable` de infraestructura, no en el dominio.

## 3. Tipos no triviales

- **`json`**: build lo deja como `String`. Para columna nativa usa
  `@JdbcTypeCode(SqlTypes.JSON)` (Hibernate 6) sobre el campo; el tipo físico
  (`jsonb` en PostgreSQL, `json`/`nvarchar` en otros) lo indica
  `references/dialects/<database>.md`.
- **Conversión de tipos**: para tipos de dominio sin mapeo directo, un
  `AttributeConverter<Dominio, ColumnaJdbc>` con `@Convert` (más limpio que anotar
  cada columna). Útil para value types escalares con formato propio.
- **Ids generados por la BD**: build asigna el `UUID` en la app (`UUID.randomUUID()`).
  Si el diseño pide id numérico secuencial, usa `@GeneratedValue` con la estrategia
  del dialecto (`SEQUENCE` donde exista; `IDENTITY` en MySQL/MariaDB — recuerda que
  IDENTITY desactiva el batching, ver `configuration.md`).
- **Texto/binario grande**: `@Lob` (o el `columnDefinition` del dialecto) más allá
  del `text` que build ya cubre con `columnDefinition = "text"`.

### Búsqueda que ignora mayúsculas y acentos

Cuando el diseño declara que una búsqueda "ignora mayúsculas y acentos", **es
implementable siempre**, con o sin extensiones de la BD. Que la vía nativa del
dialecto no esté disponible no convierte la regla en un hueco del diseño: hay
un fallback portable y hay que aplicarlo.

Por orden de preferencia:

1. **Colación insensible del dialecto**, si existe: `CITEXT`/collation
   `und-x-icu` (PostgreSQL), `utf8mb4_0900_ai_ci` (MySQL 8), `..._CI_AI`
   (SQL Server). Sin código: la comparación ya ignora caso y acento.
2. **Extensión de normalización**: `unaccent` en PostgreSQL. La extensión se crea
   desde **una migración de Flyway** (`CREATE EXTENSION IF NOT EXISTS unaccent;`),
   que es parte del esquema del servicio — no un requisito manual del entorno —,
   con un índice funcional sobre `lower(unaccent(<columna>))`. Requiere permisos
   de creación de extensión: compruébalo contra la infra de prueba antes de
   comprometerte con esta vía.
3. **Fallback portable, sin depender del dialecto** (el que aplica cuando 1 y 2
   no están disponibles): una **columna normalizada** que se puebla en el mapeo
   `toJpa` (`<campo>Normalized`), con el mismo plegado aplicado al término de
   búsqueda antes de la query. El plegado en Java es estándar:

   ```java
   public static String fold(String value) {
       if (value == null) return null;
       return Normalizer.normalize(value, Normalizer.Form.NFD)
               .replaceAll("\\p{InCombiningDiacriticalMarks}+", "")
               .toLowerCase(Locale.ROOT);
   }
   ```

   La columna se indexa como cualquier otra y la query es un `LIKE` normal. Es
   menos elegante que la vía nativa y funciona en los seis dialectos.

## 4. Auditoría y locking

- **createdAt/updatedAt**: ya los puebla build (`AuditableEntity` o, si el diseño
  declara sus propios timestamps, `@EntityListeners` + `@CreatedDate`/`@LastModifiedDate`
  sobre esos campos). No los reimplementes.
- **Autoría (`createdBy`/`updatedBy`)**: si la entidad los declara, build ya anotó los
  campos con `@CreatedBy`/`@LastModifiedBy` y dejó un `// TODO (agente)` en la `XxxJpa`
  (build también lo avisa por consola). Resuélvelo: provee un `AuditorAware<String>` que
  lea el actor del `SecurityContext` (o del correlation id si no hay usuario) y
  regístralo con `@EnableJpaAuditing(auditorAwareRef = "…")` en la clase Application.
  Sin ese bean las anotaciones no pueblan nada y las columnas quedan a `null` en
  silencio: no es opcional.
- **Locking optimista (`lockVersion`)**: **ya lo genera build** en la raíz de agregado
  (`isAggregateRoot`): campo `@Version @Column(name = "lock_version") private Long lockVersion`
  en la `XxxJpa`, `lockVersion` en el constructor de rehidratación del dominio +
  `getLockVersion()`, propagación en el mapeo, y el handler que traduce
  `ObjectOptimisticLockingFailureException` a 409 `OPTIMISTIC_LOCK_CONFLICT`.
  **No lo reañadas.** Es infraestructura pura: lo incrementa Hibernate en cada flush,
  no aparece en ningún DTO ni payload de evento, y nadie lo asigna a mano.
  Tu único trabajo aquí es el caso borde: si el diseño exige detectar updates
  concurrentes que tocan **solo entidades hijas** distintas sin modificar la raíz (JPA
  no incrementa la versión de la raíz solo), fuerza el incremento con
  `LockModeType.OPTIMISTIC_FORCE_INCREMENT` (`references/configuration.md`).
  No uses locking pesimista salvo que el diseño lo exija.
- **Un `version` declarado por el diseño no es el `@Version`**: es un contador de
  **dominio** (viaja en la API y en los payloads de eventos, y sirve a los consumidores
  para descartar eventos desordenados). Build lo mapea como campo escalar corriente,
  en su propia columna `version`, junto al `lock_version` de JPA. Lo **incrementa el
  agregado** en cada método mutador que el diseño describe como cambio observable
  — incluidos los que solo tocan entidades hijas, donde Hibernate no incrementaría
  nada. `expectedVersion` de la entrada se compara contra ese contador, y su mismatch
  es el 409 propio del diseño, distinto del `OPTIMISTIC_LOCK_CONFLICT`.
- **Soft-delete**: el DSL no lo declara; impleméntalo solo si el diseño lo pide
  (columna `deleted_at` + filtro, `@SQLDelete`/`@SQLRestriction` de Hibernate).

## Cierre

El puerto `<E>Repository`, la interfaz `<E>JpaRepository`, el adaptador
`<E>RepositoryImpl` y sus métodos (`findById`, finder por clave natural, `save`,
`deleteById`, `list` paginado) ya existen. Ajusta anotaciones y completa los
`toDomain`/`toJpa` donde build dejó TODO; no rehagas el patrón. Cada decisión no
trivial (bidireccionalidad, `@Embeddable`, converter, `OPTIMISTIC_FORCE_INCREMENT`, autoría) va
documentada en el README del proyecto generado, y debe quedar cubierta por algún
escenario `FL-*` de `validation-scenarios.md` ejecutado en vivo.
