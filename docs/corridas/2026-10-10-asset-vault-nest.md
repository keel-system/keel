# Corrida `asset-vault` — keel-nest (incremento 13: caché, storage, autoría, needs y réplica)

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.0 (DSL 2.20, documental, 9 capas) |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` |
| Generador | `keel-nest@0.0.1` (incremento 13j) |
| Diseño listo al generar | sí |
| Matriz final | **32/32 OK** |
| Huella del agente | 308 archivos registrados por `build`, 0 adoptados, **23 reescritos**, 0 borrados |
| Huecos del diseño | 3 en design-gaps.yaml (1 real, 1 del arnés, 1 que no lo es) |
| Huecos del generador | 2: la cota de cada elemento de una lista y la parte binaria vacía (ver § Arreglos) |
| Convertidos en id | — (candidato del método: `exemptClients`) |
| Clasificación de la huella | 15 TODO · 6 consulta · 2 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 11→6→6; barrido 32; revisión 18; 12 aceptadas / 20 cerradas (del barrido) |

Es la primera de las dos corridas que miden el incremento 13 de `PLAN-KEEL-NEST.md` sobre las siluetas
transversales. La otra es `2026-10-10-catalog-nest.md`. El diseño se cerró en la fixture antes de generar
(11/11 en `--ready`, commit `dae64cc`), así que **lo que encuentra la corrida es del generador o del método**.

## La huella, clasificada

| Clase | Archivos |
|---|---|
| TODO legítimo (15) | `README.md`; los 7 handlers; `asset.ts`, `owner.ts`, `asset-revision.ts`; `rendering-http-adapter.ts` (el `degrade` de `getThumbnail`, que build deja como TODO); `broker-bindings.ts`; `s3-file-storage.ts` (el adaptador S3 es del agente); `use-case-module.ts` (el registro del `CommandDispatcher` y del `AfterCommit`, ver abajo) |
| Consulta de negocio (6) | `caller-scope.ts` y `jwt-caller-scope.ts` (`isMachineClient()`: la exención de `rendering-service` vive en una regla de `getAsset`); `asset-repository.ts` y su adaptador (`findByChecksum`, por el orden de comprobaciones que fija una regla, y `listByOwnerIds`, por el alcance del listado); `owner-repository.ts` y su adaptador (`findAllByCodes`, la resolución del claim `vaults`) |
| Hueco del generador (2) | `asset-v1-controller.ts` (la cota de cada etiqueta) y `multipart-reading.ts` (la parte vacía) |

**El agente cableó dos piezas a mano**, y las dos salen de una regla en prosa:
- el `CommandDispatcher`, porque `reconcileScans` despacha `quarantineAsset`;
- un puerto `AfterCommit`, porque la retirada de la miniatura se encarga «tras confirmar».

La corrida de catalog escribió **el mismo `AfterCommit`, idéntico**, por su cuenta. Desde esta corrida lo emite
build (`src/scaffold/after-commit.js`). El `CommandDispatcher` no: los dos generadores lo emiten solo para las
operaciones internas que nadie dispara, y aquí el despacho solo lo dice una regla.

## Arreglos

Los dos son de los dos generadores, no solo de keel-nest:

1. **La cota de cada elemento de una lista** (`labels: { maxItems: 20, maxLength: 40 }`). Solo se validaba el
   contenedor, así que una etiqueta de 41 caracteres entraba por la API. Ahora `elementValidationRules`
   (`keel-core/gen/constraints.js`) da las reglas del elemento:
   - keel-nest las aplica con `Violations.checkEach`;
   - keel-spring las escribe dentro del tipo: `List<@Size(max = 40) String>`.
2. **Una parte binaria obligatoria que llega vacía.**
   - keel-nest le pasaba `null` al handler, y el resultado era un 500.
   - keel-spring respondía `VALIDATION_ERROR`, por su `@NotNull`.
   - El catálogo del framework dice `FILE_UNREADABLE`, y es lo que responden ahora los dos.

Los mide `keel-nest/test/input-bounds.test.js`, que ejecuta `checkEach` y comprueba lo que emite keel-spring, y
`storage.test.js` ejecuta la lectura multipart.

## Lo que vuelve al método

- **`exemptClients`**: la exención de alcance de un cliente máquina no tiene dónde declararse. Salió al cerrar el
  diseño y lo confirma la huella: dos archivos de seguridad reescritos para decir algo que el diseño ya decidió.
- **El despacho de una operación desde otra** (el barrido que pone en cuarentena) solo cabe en prosa. Con un
  enlace estructural, build emitiría el `CommandDispatcher` como emite el `RefResolver`.

## designGaps

- `subscription-text-bound` — el `reason` de `MalwareDetected` no lleva cota en el payload y `quarantineReason` sí (500): el diseño no dice si se trunca o se rechaza. **Real**; se cierra en el diseño.
- `test-realm-claim-values` — los escenarios usan un `vault-reader` con `vaults=["OTRO"]` y el realm de prueba no lo siembra. Es del arnés, no del diseño: el realm no sabe dar a un usuario un valor de claim concreto.
- `concurrent-outcome-disjunction` — el agente pedía fijar más que la disyunción en las entregas concurrentes. No es un hueco: la disyunción es el contrato.
