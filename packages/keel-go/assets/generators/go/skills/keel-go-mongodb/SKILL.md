---
name: keel-go-mongodb
description: Guía de la persistencia documental (MongoDB) en un proyecto generado por keel-go — qué genera build (el documento de cada agregado, los adaptadores sobre el driver oficial sin su mapeo por reflexión, la transacción de cada caso de uso sobre el replica set, los índices al arrancar y la traducción de cada violación), qué le toca al agente (usar los puertos desde los handlers) y los fallos típicos. Usar cuando keel-stack.json declara database "mongodb".
---

# Persistencia documental (MongoDB, driver oficial v2)

La persistencia sale **entera** de build, con la cabecera de código generado en cada archivo, en
`internal/infrastructure/mongo`: el agregado ES el documento (sus entidades internas anidadas, un value object como
subdocumento, una referencia a otro agregado como su id en `<relación>_id`) con la representación física de Keel —los
mismos nombres de campo, tipos BSON e índices que los servidores de keel-spring, keel-nest y keel-dotnet del diseño—,
un adaptador por raíz (`<raíz>_repository.go`, que escribe el `bson.D` y lee el `bson.Raw` campo a campo, sin el mapeo
por reflexión del driver), la transacción que abre `UseCases` para cada caso de uso sobre una sesión del replica set
(`transactions.go`), los índices que el servidor crea al ARRANCAR (`indexes.go`) y la traducción de cada violación de
un índice único al error del diseño (`errors.go`, por el nombre del índice en el mensaje E11000). El paquete exporta
los mismos nombres que la rama relacional, así que el resto del servicio no distingue.

**El agente no escribe persistencia.** Lo suyo es llamar a los puertos (`domain.<Raíz>Repository`) desde los
handlers, en el orden de las notas del diseño: los mismos puertos que en relacional, con la misma forma
(`references/repository-adapters.md`).

## Antes de empezar

- Lee `specs/persistence.keel.yaml`: claves naturales, índices (con su `when`) y `consistency`.
- Lee el puerto de cada raíz en `internal/domain/<raíz>_repository.go`.

## Qué hace cada agente aquí

| Agente | Trabajo | Referencia |
|---|---|---|
| código | llamar a los puertos desde los handlers | `references/repository-adapters.md` |
| pruebas | mirar el almacén o fabricar una precondición con `s.MongoEval(...)` | `references/harness.md` |
| calidad | VERIFICAR los índices vivos contra los de build | `references/indexes.md` |
| cualquiera | diagnosticar un fallo del motor | `references/troubleshooting.md` |

## Reglas que no se rompen

- Ningún handler ni endpoint ve el `*mongo.Client`, una sesión ni un `bson.D`: `internal/application` no puede
  importar el driver (lo veta `internal/architecture`). Todo pasa por el puerto.
- El puerto se usa **con el `ctx` que recibe el handler**: lleva la sesión de la transacción que abrió `UseCases`. Un
  `context.Background()` escribiría fuera de ella y un aborto no la desharía.
- Los nombres de los índices (`uk_*`, `ix_*`) y de los campos del documento (snake_case, `_id`) son **contrato**:
  `errors.go` traduce por el nombre del índice, el arnés consulta por esos campos y el otro servidor del diseño lee lo
  que este escribe.
- No hay migraciones: el «esquema» son los índices que el servidor asegura al arrancar. No se crea un índice a mano ni
  en otro sitio: uno que no salga de `indexes.go` no lo conoce el traductor.
- Las transacciones solo existen sobre un **replica set** (infra/ lo arranca así también en local). Dos casos de uso
  sobre el mismo documento no se esperan: el segundo aborta con un conflicto transitorio y la transacción se repite
  entera (hasta tres veces; agotado, el 409 de concurrencia). Por eso un handler no hace fuera de la base nada que no
  pueda repetirse.
- La versión del bloqueo optimista (`LockVersion`) no se toca: `Save` la pone en el filtro y una obsoleta es el error
  de concurrencia del contrato.
- Un reclamo de barrido (`ClaimFor…`) ya es atómico por documento (FindOneAndUpdate) y confirma al volver: no corre
  dentro de una transacción abierta (el reloj ya despacha sin ella).
- El reclamo de reconciliación (`ClaimForReconcile…`) también va generado: lee los candidatos sin marca viva y estampa la
  marca en `reconciliation_claim` con un upsert fuera de toda transacción. No escribas otro: lo verifica la familia
  `reconciliation` de `infra/check-idempotency.sh`.
