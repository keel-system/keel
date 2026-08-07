---
name: keel-spring-mongodb
description: Guía de MongoDB en un proyecto generado por keel-spring — índices, transacciones sobre replica set, tuning del driver, consultas de lectura compuestas ($lookup) y evolución de documentos; el código documental (espejos XxxDocument, MongoRepository, adaptadores, MongoIndexConfig) ya lo genera build. Usar cuando keel-stack.json declara database "mongodb".
---

# MongoDB (`database: mongodb`)

El código de persistencia del **caso común** sale de build: espejo `XxxDocument`,
`XxxMongoRepository`, puerto + adaptador `XxxRepositoryImpl`, auditoría
(`AuditableDocument`), `MongoIndexConfig` con todos los índices del diseño,
`MongoTransactionConfig` y la conexión en `parameters/<perfil>/db.yaml`.
**No rehagas ese patrón.** Build nunca deja código que no compila: donde no puede
decidir deja un `// TODO (agente): …` que debes resolver.

La idea que gobierna todo lo demás: **el agregado es el documento**. La raíz es una
colección; sus entidades internas van anidadas dentro de ella, no en colecciones
propias. Una relación a **otro** agregado es un `UUID` y nada más — nunca un
`@DBRef` (ver `references/document-mapping.md`, es la regla dura de esta skill).

Esta skill cubre lo que build no puede decidir: tuning, consultas compuestas,
evolución del esquema de documentos y verificación de índices.

## Antes de empezar

- Lee `specs/persistence.keel.yaml`: clave natural, índices y `consistency` — el
  diseño es la única fuente de verdad funcional.
- Sigue estrictamente `{{keel:docs}}/conventions/mapping.md` § *El agregado es un
  documento*; la estructura de paquetes está en
  `{{keel:docs}}/conventions/project-layout.md`.
- **Frontera**: build ya dejó el código documental, los índices, la config por
  perfil y el compose. Esta skill cubre tuning, lectura compuesta, evolución y
  verificación.

## Qué dejó listo build

- `build.gradle`: `spring-boot-starter-data-mongodb` +
  `de.flapdoodle.embed.mongo.spring3x` como `testImplementation` (el perfil `test`
  corre sobre un mongod embebido, análogo del H2 de la rama relacional).
- `parameters/<perfil>/db.yaml`: la URI con gradiente por perfil
  (`directConnection=true` en local, porque la app corre en el host y el miembro se
  anuncia con el nombre de red del contenedor) y `auto-index-creation: false`.
- `infrastructure/persistence/documents/`: los espejos `XxxDocument`, con las hijas
  anidadas, los value objects como subdocumentos, `@Version` en la raíz y las
  anotaciones de auditoría que pida `persistence.audit`.
- `infrastructure/persistence/config/MongoIndexConfig`: **todos** los índices del
  diseño, con sus nombres (`uk_*`, `idx_*`). Ese nombre es un contrato con el
  `ApiExceptionHandler` — ver `references/indexes.md`.
- `infrastructure/persistence/config/MongoTransactionConfig`: el
  `MongoTransactionManager` sin el cual el contexto no arranca (el `UseCaseMediator`
  exige un `PlatformTransactionManager`), y un gestor no-op para el perfil `test`.
- `infra/docker-compose.yaml`: Mongo arrancado **como replica set** de un miembro,
  con un healthcheck que además lo inicia; `infra/reset-db.sh` (vacía documentos,
  preserva índices) e `infra/export-indexes.sh` (lee los índices vivos).

## Qué hace el agente

1. **Resolver los TODO de build**: busca `// TODO (agente)` en
   `infrastructure/persistence/` y complétalos con `references/document-mapping.md`.
   Ojo: el value object anidado, que en la rama relacional deja un TODO, aquí **ya
   sale generado** — es un subdocumento dentro de otro.
2. **Verificar los índices**: `bash infra/export-indexes.sh` y contrastar contra
   `MongoIndexConfig` y `specs/persistence.keel.yaml`, en los dos sentidos. Es una
   verificación, no una redacción: build ya los generó. Procedimiento en
   `references/indexes.md`.
3. **Composición de lecturas**: el `<X>RefResolver` por lote que genera build
   resuelve los `embed` sin N+1 y es lo primero que hay que intentar. Solo cuando el
   diseño exige **filtrar u ordenar** por un campo del agregado ajeno hace falta un
   `$lookup` en un adaptador de lectura separado — criterio en
   `{{keel:docs}}/conventions/read-composition.md`, técnica en
   `references/read-queries.md`.
4. **Tuning solo si un escenario lo pide**: pool del driver, `readPreference`,
   `writeConcern` — con `references/configuration.md`. No tunees por adelantado. Un
   listado que hace una consulta por elemento (N+1) no es tuning pendiente: es un
   defecto desde el primer día.
5. **Evolución de documentos**: añadir, renombrar o mover un campo no lo cubre
   ningún mecanismo generado (no hay Flyway aquí, y no hace falta para los índices).
   Cuándo basta con leer tolerando la forma vieja y cuándo hace falta una migración
   de datos, en `references/document-mapping.md` § *Evolución*.

## Referencias

Léelas bajo demanda, no todas de golpe:

| Referencia | Cuándo leerla |
|---|---|
| `references/document-mapping.md` | Al resolver un `// TODO (agente)` de persistencia, al mapear algo que build no cubre, o al evolucionar la forma de un documento ya escrito |
| `references/indexes.md` | Al verificar los índices contra el diseño, al añadir uno nuevo o al depurar un `E11000` que no se traduce al error declarado |
| `references/transactions.md` | Al tocar transaccionalidad, al depurar «Transaction numbers are only allowed on a replica set member» o al razonar sobre la atomicidad agregado + outbox |
| `references/read-queries.md` | Al implementar una query que filtra u ordena por un campo de un agregado **embebido** (`embed`), que es cuando el lote del `<X>RefResolver` no basta y hace falta `$lookup` |
| `references/configuration.md` | Antes de tocar `parameters/<perfil>/db.yaml` o propiedades `spring.data.mongodb.*` (URI, pool, concerns, representación de UUID) |
| `references/troubleshooting.md` | Si el arranque, la conexión o las queries fallan (replica set sin iniciar, UUID que no se ven en mongosh, documento que crece sin cota) |

## Validación

Sondeo y reset desde el propio contenedor de Mongo (mongosh vive en su imagen):
`infra/validate-infra.sh` y `bash infra/reset-db.sh` entre flujos. El sondeo
comprueba `rs.status()`, no un ping: una base que responde pero cuyo replica set no
arrancó fallaría en la primera transacción.
Recetas completas en `{{keel:docs}}/conventions/infra-validation.md`.
