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

## 4. Auditoría y locking

- **createdAt/updatedAt**: ya los puebla build (`AuditableEntity` o, si el diseño
  declara sus propios timestamps, `@EntityListeners` + `@CreatedDate`/`@LastModifiedDate`
  sobre esos campos). No los reimplementes.
- **Autoría (`createdBy`/`updatedBy`)**: si el diseño la pide, añade los campos con
  `@CreatedBy`/`@LastModifiedBy` y provee un `AuditorAware<String>` que lea el actor
  del `SecurityContext` (o del correlation id si no hay usuario). Regístralo con
  `@EnableJpaAuditing(auditorAwareRef = "…")`.
- **Locking optimista (`@Version`)**: si el diseño declara concurrencia sobre un
  agregado (o `flow-fidelity` detecta updates concurrentes), añade `@Version private
  Long version` en la entidad `XxxJpa` y mapea la `OptimisticLockException` al error
  409 del diseño. Detalle en `references/configuration.md`. No uses locking pesimista
  salvo que el diseño lo exija.
- **Soft-delete**: el DSL no lo declara; impleméntalo solo si el diseño lo pide
  (columna `deleted_at` + filtro, `@SQLDelete`/`@SQLRestriction` de Hibernate).

## Cierre

El puerto `<E>Repository`, la interfaz `<E>JpaRepository`, el adaptador
`<E>RepositoryImpl` y sus métodos (`findById`, finder por clave natural, `save`,
`deleteById`, `list` paginado) ya existen. Ajusta anotaciones y completa los
`toDomain`/`toJpa` donde build dejó TODO; no rehagas el patrón. Cada decisión no
trivial (bidireccionalidad, `@Embeddable`, converter, `@Version`, autoría) va
documentada en el README del proyecto generado, y debe quedar cubierta por algún
escenario `FL-*` de `validation-scenarios.md` ejecutado en vivo.
