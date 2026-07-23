# validation-scenarios.md — escenarios de validación del servicio

Formato del artefacto `specs/<servicio>/validation-scenarios.md`: escenarios de aceptación ejecutables (Given/When/Then) derivados del diseño. Es el **contrato de validación de la fase de generación**: el agente del generador lo usa para derivar tests de integración y para ejecutar los escenarios contra el servidor generado en marcha.

Lo produce `/keel-design` como paso final del cierre del diseño, y se regenera cada vez que el spec cambia. Es un artefacto **derivado**: todo (rutas, payloads, códigos de error, estados, eventos) se copia exacto de los artefactos YAML — nunca inventa contrato que no esté en el diseño.

## Estructura del archivo

```markdown
# <servicio> — Escenarios de validación

> Escenarios de aceptación ejecutables (Given/When/Then) derivados de
> specs/<servicio> v<service.version>. Contrato de validación para la fase de generación.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| createProduct  | FL-PRD-001 | usuarios |
| getProductPrice | FL-PRD-010 | **servidores (M2M)** |
| ...          | ...   | ... |

> La columna **Superficie** marca los endpoints expuestos a otros servidores
> (`audience: services`/`both`) para que su cobertura como contrato servidor-a-servidor
> sea visible de un vistazo. Omítela si el servicio no expone ninguno.

## <Agrupación natural (p.ej. por entidad o agregado)>

### FL-XXX-NNN: <título en lenguaje de negocio>

**Given**: ...
**When**: ...
**Then**: ...
**Orden de evaluación**: ...
**Ramas condicionales**: ...
**Casos borde**: ...
```

## Reglas de cobertura

- **Toda operación de `use-cases.keel.yaml` aparece en la matriz** con al menos un flujo. Una matriz incompleta significa diseño sin cerrar.
- Cada `command` cubre su camino feliz **y cada `error` declarado** (como paso del orden de evaluación o como caso borde, con su `code` y status HTTP exactos).
- Cada transición de `lifecycle` relevante tiene escenario (y al menos un caso borde de transición inválida).
- Cada evento de `emits` aparece en el **Then** del escenario que lo publica, con su nombre, su payload relevante y —si el diseño lo declara— el `channel` de messaging por el que se emite.
- **Si el diseño declara `messaging: subscriptions`**, cada suscripción tiene al menos un escenario que valida su **consumo**: **Given** el estado previo, **When** llega un evento entrante por su `channel`/`source` declarado con un payload de ejemplo, **Then** se ejecuta la operación `triggers` y se producen sus efectos observables. Además, un **caso borde de fallo** ejercita la política `onFailure`: reintentos (`retry`) y, si `deadLetter: true`, el envío del mensaje a la DLQ tras agotarlos.
- Las validaciones de input (constraints de value types, campos requeridos) se cubren como casos borde `400`.
- **Si el diseño declara `storage`**, las operaciones que suben archivos a un bucket cubren el **camino feliz** (el archivo queda almacenado en su bucket y es referenciable desde la entidad) y, según la `visibility` del bucket, la forma de lectura resultante (acceso directo si `public`; URL firmada o lectura mediada si `private`). Cubren además como casos borde el rechazo por tamaño (`FILE_TOO_LARGE`) y por content-type no permitido (`UNSUPPORTED_CONTENT_TYPE`), según las políticas del bucket.
- Operaciones `internal: true` (sin endpoint) se describen por su disparador real (subscription, schedule u operación interna consumida por otro servicio).
- **Si el diseño declara endpoints expuestos a otros servidores** (capa api con `audience: services`/`both` y security con `serviceAuth`), cada operación con `level: service` se valida como **superficie de integración servidor-a-servidor** —el mismo contrato que documenta `/keel-integrate` en `INTEGRATION.md`—, no solo por su auth:
  - **Contrato funcional (camino feliz)**: la llamada con credencial de máquina válida y los scopes exigidos, con la **forma real del request** (los campos del payload que otro servidor envía) y la verificación en el **Then** del **response completo** que ese servidor consume (los campos del payload que viajan por M2M, coherentes con `INTEGRATION.md`), no solo el status `2xx`.
  - **Errores declarados**: cada `error` de la operación se cubre **ejercido con credencial de máquina** (mismo criterio que la regla general de commands, pero desde el público servidor), con su `code` y status HTTP exactos.
  - **Auth**: la llamada con credencial de máquina **sin** el scope exigido (`403`), y —si `validateAudience: true`— el token emitido para otra audiencia (`401`). Los endpoints `audience: both` cubren además el acceso con token de usuario.
  - Los escenarios hablan de "credencial de máquina del cliente `<serviceClient>`", nunca del proveedor concreto.

## Secciones de cada escenario

- **Id**: `FL-<PREFIJO>-NNN`, donde `<PREFIJO>` son 3-4 letras de la entidad/agrupación (`CAT`, `PRD`) y `NNN` es secuencial dentro de ella.
- **Given** — estado previo mínimo y verificable: entidades existentes con los campos que importan, y lo que *no* existe cuando la unicidad es la regla bajo prueba.
- **When** — la llamada concreta: método + ruta del artefacto api (con versión y path params) y body de ejemplo realista. Para triggers no HTTP, el evento (con su `channel`/`source`) o schedule que dispara la operación.
- **Then** — lo observable: status HTTP y headers del contrato (`Location`, etc.), efectos sobre el estado (campos y transiciones resultantes) y eventos publicados con su payload relevante y su canal.
- **Orden de evaluación** — solo en commands con preconditions/rules: la secuencia numerada de guardas en el orden del artefacto use-cases, cada una con su error (`code` + status) si falla. Es el contrato de implementación: el orden importa.
- **Ramas condicionales** — solo si la operación se comporta distinto según qué campos del input llegan (p.ej. updates parciales que recalculan campos `computed` solo si su fuente cambió).
- **Casos borde** — entradas inválidas (`400`), colisiones (`409`), no encontrados (`404`), y cualquier combinación de estado que active un error declarado no cubierto por otro flujo.

## Criterios de calidad

- Datos de ejemplo realistas y coherentes entre escenarios (mismo dominio de negocio, mismos identificadores simbólicos `c1`, `p1` reutilizados en los Given).
- Escenarios independientes: cada Given describe todo lo necesario, sin depender de la ejecución de otro flujo.
- Nada de tecnología: los escenarios hablan de HTTP, estados, eventos y canales lógicos del diseño, jamás de tablas, frameworks, brokers, topics o colas concretos. Los nombres lógicos de `channel` y `bucket` son contrato del diseño y sí aparecen; su materialización (Kafka/RabbitMQ, S3/MinIO) no.
- Los ids `FL-*` son estables: al iterar el diseño se añaden flujos nuevos, no se renumeran los existentes.
