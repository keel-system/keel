---
name: keel-nest-database
description: Guía de la base de datos relacional en un proyecto generado por keel-nest — ampliar un puerto de repositorio y su adaptador TypeORM, el baseline de migraciones (exportarlo, revisarlo y verificarlo en vivo), la configuración por perfiles y los fallos típicos; el código de persistencia (entidades, adaptadores, transacción, traducción de constraints) ya lo genera build. Usar cuando keel-stack.json declara database "postgresql" o "mysql".
---

# Base de datos relacional (database: la de `keel-stack.json`)

El código de persistencia sale entero de build: las entidades TypeORM (`infrastructure/persistence/
entities/`) sobre el esquema neutral de Keel —los mismos nombres de tabla, columna, constraint, índice y
FK que el servidor de keel-spring del diseño—, un adaptador por raíz (`<Raíz>RepositoryImpl`, con
`toDomain`/`toOrm` explícitos), el `DataSource` por perfil, la transacción que abre el mediator
(`TransactionContext`, AsyncLocalStorage), el bloqueo optimista, la auditoría, la unicidad condicionada y
la traducción de cada violación de constraint al error del diseño (`persistence-errors.ts` +
`ApiExceptionFilter`). **No rehagas ese patrón**: extiéndelo.

## Antes de empezar

- Lee `specs/persistence.keel.yaml`: mapeo, claves naturales, índices y `consistency`.
- Sigue `{{keel:docs}}/conventions/mapping.md` § persistence.

## Qué hace cada agente aquí

| Agente | Trabajo | Referencia |
|---|---|---|
| código | ampliar un puerto de `domain/repository` **y** su adaptador cuando un handler necesita una consulta que build no derivó | `references/repository-adapters.md` |
| calidad | el **baseline de migraciones**: exportarlo, revisarlo, copiarlo a `src/migrations/` y verificarlo en vivo | `references/migrations.md` |
| cualquiera | diagnosticar un fallo del motor | `references/troubleshooting.md` |
| cualquiera | qué lee cada perfil | `references/configuration.md` |

## Reglas que no se rompen

- Ningún handler ni controlador importa una entidad ORM, un `EntityManager`, un `DataSource` ni
  `typeorm`: la frontera hexagonal lo prohíbe y `npm run check:architecture` lo comprueba.
- El adaptador usa **siempre** `this.manager` (el `EntityManager` de la transacción abierta por el
  mediator): uno propio escribiría fuera de la transacción y un rollback no lo desharía.
- Los nombres de constraint, índice y FK de las entidades son **contrato**: el filtro de errores traduce
  por ellos al `code` del diseño, y el servidor de keel-spring usa los mismos. No se renombran.
- `synchronize` solo en `local`. En `develop` y `production` el esquema es el de las migraciones.
- `lockVersion` no se toca: el adaptador ya hace el UPDATE condicionado por la versión (TypeORM no la
  comprueba) y lo traduce a 409.
