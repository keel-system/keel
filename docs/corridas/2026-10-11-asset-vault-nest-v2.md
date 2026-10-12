# Corrida `asset-vault` — keel-nest, de control (la v2 de `2026-10-10-asset-vault-nest.md`)

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.2 (DSL 2.21, documental, 9 capas) |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` |
| Generador | `keel-nest@0.0.1` con todo lo del 2026-10-11 (clave por correlación, finders, `tokenWithScope`, sombra de filtro, Cognito) |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** del diseño (38 en el informe: 6 casos `-V*` de validación añadidos por el agente) |
| Huella del agente | 312 archivos registrados por `build`, 0 adoptados, **18 reescritos**, 0 borrados |
| Huecos del diseño | 2 en design-gaps.yaml (ninguno real; ver § designGaps) |
| Huecos del generador | 2 en la huella y 1 en el informe (ver § Arreglos) |
| Convertidos en id | — |
| Clasificación de la huella | 14 TODO · 2 consulta · 2 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | el de la v1.1.0 más los parches 1.1.1 y 1.1.2 |

Dos puntuaciones: 27 OK + 11 FALLO, todos `culprit: test` por una sola causa (el cuerpo esperado de la ficha sin
`revisions: []`) → 38/38.

## Lo que midió (frente a la v1)

De 23 reescritos a 18. Se usaron tal como los emite build `findByChecksum`, `findAllByCodeIn` (la resolución del
claim del alcance), el `CommandDispatcher`, el `OperationCache` y el `JwtCallerScope` con `exemptClients`.

## La huella, clasificada

| Clase | Archivos |
|---|---|
| TODO legítimo (14) | `README.md`; los 7 handlers; `asset.ts`, `owner.ts`, `asset-revision.ts`; `rendering-http-adapter.ts` (el `degrade`); `broker-bindings.ts`; `s3-file-storage.ts` |
| Consulta de negocio (2) | `asset-repository.ts` y su adaptador: `listByOwnerIdIn`, el listado acotado a los propietarios del claim |
| Hueco del generador (2) | `owner-repository.ts` y su adaptador: `findAllByIdIn`, la lectura por lote del `embed: [owner]` de una página |

## Arreglos

1. **`CommandSignature` con un binario** (informe): la forma canónica de keel-nest no tenía rama para `Uint8Array`,
   así que el comando de `uploadAsset` se firmaba recorriendo byte a byte hasta 25 MB. El agente firmó una
   proyección a mano. Ahora entra por su SHA-256, como el `byte[]` de keel-spring.

2. **La lectura por lote del `embed`**, segunda corrida de keel-nest (`findAllByIds` en la v1, `findAllByIdIn`
   aquí): keel-spring emitía el `<Raíz>RefResolver` y `findAllById`; keel-nest, las `RefDto` y sus mappers pero no
   la lectura. Ahora keel-nest emite `findAllById` en el puerto y los dos adaptadores y el `OwnerRefResolver`, que
   el handler recibe inyectado con la nota del lote; qué raíces lo necesitan lo decide `keel-core/gen/ref-targets.js`.

## designGaps

- `subscription-missing-target-lost` — el agente decía que un `ThumbnailDelivered` con `assetId` inexistente se
  pierde. No: el destino `asset-vault.rendering` no reintenta el NOT_FOUND (no hay guarda de dominio), así que va
  a la DLQ al primer fallo. Lo que sí es cierto es la contrapartida de `tryRecord`, que el diseño eligió al no
  declarar `transitions`: la marca se confirma aparte, un fallo transitorio pierde el mensaje y un reenvío desde la
  DLQ se descartaría como duplicado. No es hueco.
- `scenario-then-empty-list` — que los Then de la ficha no digan `revisions: []`. El contrato del cable fija que una
  lista vacía viaja como `[]`. No es hueco; fue la causa de los 11 rojos de la primera puntuación.
