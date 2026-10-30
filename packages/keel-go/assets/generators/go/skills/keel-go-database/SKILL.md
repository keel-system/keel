---
name: keel-go-database
description: Guía de la base de datos relacional en un proyecto generado por keel-go — qué genera build (esquema como migración de goose, adaptadores sobre database/sql, transacción de cada caso de uso, traducción de constraints), qué le toca al agente (usar los puertos desde los handlers) y los fallos típicos. Usar cuando keel-stack.json declara database "postgresql" o "mysql".
---

# Base de datos relacional (database/sql + PostgreSQL o MySQL)

La persistencia sale **entera** de build, con la cabecera de código generado en cada archivo: el esquema como una
migración de goose (`internal/infrastructure/<motor>/migrations/00001_baseline.sql`, embebida en el binario) sobre
el esquema neutral de Keel —los mismos nombres de tabla, columna, constraint, índice y FK que los servidores de
keel-spring, keel-nest y keel-dotnet del diseño—, un adaptador por raíz (`<motor>/<raíz>_repository.go`, con el SQL
escrito a mano, parametrizado y sin ORM), la transacción que abre `UseCases` para cada caso de uso
(`<motor>/transactions.go`), el bloqueo optimista, la unicidad condicionada, los finders de las búsquedas y la
traducción de cada violación de constraint al error del diseño (`<motor>/errors.go`, por el nombre de la
constraint). `<motor>` es `postgres` o `mysql`, según `keel-stack.json`; los dos paquetes exportan los mismos
nombres, así que el resto del servicio no distingue.

**El agente no escribe persistencia.** Lo suyo es llamar a los puertos (`domain.<Raíz>Repository`) desde los
handlers, en el orden de las notas del diseño.

## Antes de empezar

- Lee `specs/persistence.keel.yaml`: mapeo, claves naturales, índices y `consistency`.
- Lee el puerto de cada raíz en `internal/domain/<raíz>_repository.go`: cada método dice qué devuelve y cuándo
  `found` es `false`.

## Qué hace cada agente aquí

| Agente | Trabajo | Referencia |
|---|---|---|
| código | llamar a los puertos desde los handlers; usar el finder que nombra la nota | `references/repository-ports.md` |
| calidad | comprobar que nadie añadió una migración ni tocó la baseline | `{{keel:agents}}` → `keel-go-quality` |
| cualquiera | diagnosticar un fallo del motor | `references/troubleshooting.md` |

## Reglas que no se rompen

- Ningún handler ni endpoint ve el `*sql.DB`, una `*sql.Tx` ni SQL: `internal/application` no puede importar
  `database/sql` (lo veta `internal/architecture`). Todo pasa por el puerto.
- El puerto lo usa el handler **con el `ctx` que recibe**: lleva la transacción que abrió `UseCases`. Un
  `context.Background()` escribiría fuera de ella y un rollback no lo desharía.
- Los nombres de constraint, índice y FK son **contrato**: `errors.go` traduce por ellos al `code` del diseño, y los
  otros tres servidores usan los mismos.
- El esquema es la migración de build y la aplica goose al arrancar, **en todos los perfiles**. No se añade otra
  migración ni se edita la baseline: un cambio del esquema es un cambio del diseño.
- Una búsqueda con todos sus inputs enlazados (DSL 2.22: por nombre o con `filter`, más su `where`) ya tiene su
  **finder de build** en el puerto y en el adaptador: el handler lo llama y la nota dice con qué. Si una `rule`
  restringe algo que el finder no aplica, es un `designGap`, no un filtro en memoria.
- Un campo con `compare: ignore-case` o `ignore-case-accents` lleva su sombra plegada `<columna>_normalized`: la
  estampa el adaptador y la usan la unicidad y los finders, plegada con `internal/platform/textfold`. El handler no
  pliega nada a mano para buscar: pasa el texto como llegó.
- La versión del bloqueo optimista (`LockVersion`) no se toca: `Save` la compara y una obsoleta es el error de
  concurrencia del contrato.
- En MySQL el uuid va en `binary(16)` con los bytes en el orden del texto (lo convierte el adaptador): un
  `s.Db("… WHERE id = '<uuid>'")` desde una prueba no casa con nada; va `UUID_TO_BIN('<uuid>')`.
