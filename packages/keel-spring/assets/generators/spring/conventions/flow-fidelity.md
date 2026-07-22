# Auditoría de fidelidad al flujo

Checklist **obligatoria antes de editar cada handler**. La ejecuta el agente de código
(`keel-spring-code`) por cada operación, cruzando `use-cases.keel.yaml` +
`domain.keel.yaml` + los flujos `FL-*` de `specs/validation-scenarios.md`. Su objetivo
es que la implementación cubra exactamente lo que el diseño declara — ni menos (casos
borde sin cubrir) ni más (comportamiento inventado).

Si la auditoría revela una **contradicción entre artefactos** (use-cases vs api vs
validation-scenarios) o un hueco del diseño (un caso borde sin `error` declarado),
**detente y repórtalo como bloqueo**: es un defecto del diseño que se corrige en los
artefactos, nunca se resuelve en silencio en el código.

## Checklist por operación

- **Campos opcionales**: si un componente del input tiene `required: false`, parsea o
  consulta ese valor solo cuando venga presente. Nunca `UUID.fromString(command.x())`
  ni una consulta por un campo opcional sin guardia de nulidad.
- **Casos borde**: cada escenario de error o borde de los flujos `FL-*` que tocan la
  operación debe quedar cubierto por una excepción de dominio (`<PascalCode>Error` con
  el `code` **exacto** de `errors[]`), una transición idempotente o una respuesta
  explícita. Si el escenario existe pero el `error` no está declarado en el diseño →
  bloqueo (hueco del diseño).
- **Estado terminal**: un estado del `lifecycle` con transiciones `[]` es terminal.
  Verifica **todos** los métodos afectados (actualización, entidades hijas, cambios de
  estado), no solo el handler de la transición: ninguna mutación debe aceptarse sobre
  una raíz en estado terminal si el diseño no lo permite.
- **Transiciones idempotentes**: si un flujo exige éxito cuando el estado ya es el
  destino, el método de dominio retorna sin re-emitir el evento. El guard genérico
  `transitionTo` no cubre esto: hazlo explícito en el método semántico.
- **Entidades hijas del agregado**: remover o actualizar una hija inexistente debe
  buscar primero y lanzar el `*_NOT_FOUND` declarado; nada de `removeIf` silencioso.
- **Eventos — emisión y no-emisión**: confirma que se publica exactamente lo que
  `emits` declara, y que los caminos de error o idempotentes **no** publican. El
  nombre del evento es contrato público: se copia exacto.
- **Validación cross-agregado**: una precondición que consulta otra raíz de agregado
  del servicio se hace vía **su** repository (puerto), antes del método de dominio, y
  respetando `consistency.transactionalBoundary` (con `per-aggregate`, el command solo
  muta una raíz; la otra solo se lee). Datos de **otro servicio** llegan por la capa
  `http-clients` o por eventos de `messaging`, nunca inyectando persistencia ajena.
- **Bloqueo optimista (si se usa)**: el scaffolding no genera `@Version`; si lo añades
  a una `XxxJpa`, el agregado de dominio debe declarar `version` con getter y el
  mapper propagarlo en `toDomain()`/`toJpa()`. Un `@Version` sin round-trip completo
  no protege nada: complétalo o no lo introduzcas.
- **Wiring HTTP**: si el binding, el `successStatus`, el `Location` o los query params
  generados no coinciden con `api.keel.yaml`, repórtalo como defecto del scaffolding —
  no cambies firmas ni contratos generados para compensarlo.
- **Imports y compilación**: tras tocar agregados/handlers/mappers/servicios, verifica
  que errores, value objects y DTOs usados están importados y el proyecto compila.

## Cierre del paso

Tras implementar el handler, repasa la checklist de nuevo: ningún caso borde de los
flujos que tocan la operación puede quedar sin cubrir. Los tests derivados
(`mapping.md`, sección Tests) son la red que lo confirma.
