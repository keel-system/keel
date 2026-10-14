# Auditoría de fidelidad al flujo

Checklist **obligatoria antes de editar cada handler**. La ejecuta el agente de código por cada operación,
cruzando `use-cases.keel.yaml` + `domain.keel.yaml` + los flujos `FL-*` de `specs/validation-scenarios.md`. Su
objetivo es que la implementación cubra exactamente lo que el diseño declara — ni menos (casos borde sin cubrir)
ni más (comportamiento inventado).

Si revela una **contradicción entre artefactos** o un caso borde sin `error` declarado, **detente y repórtalo**:
es un defecto del diseño y se corrige en los artefactos, nunca en silencio en el código.

## Checklist por operación

- **Campos opcionales**: un componente del input con `required: false` llega como `null` (o, en un PATCH, como
  `Optional<T>` sin valor: ausente no es nulo). Se usa solo cuando viene presente. Nada de `command.X!` sobre un
  opcional.
- **Casos borde**: cada escenario de error o borde de los flujos que tocan la operación queda cubierto por un
  `<PascalCode>Error` con el `code` **exacto** de `errors[]`, una transición idempotente o una respuesta
  explícita. Si el escenario existe y el error no está declarado → bloqueo.
- **Estado terminal**: un estado del `lifecycle` sin transiciones es terminal. Ninguna mutación se acepta sobre
  una raíz en estado terminal si el diseño no lo permite — revisa todos los métodos afectados, no solo el de la
  transición.
- **Transiciones idempotentes**: si un flujo exige éxito cuando el estado ya es el destino, el método semántico
  retorna sin error. `TransitionTo` no lo cubre.
- **Entidades hijas**: quitar o actualizar una hija inexistente busca primero y lanza el `*_NOT_FOUND`
  declarado; nada de filtrar en silencio.
- **Validación cross-agregado**: una precondición que consulta otra raíz del servicio va por **su** puerto, antes
  del método de dominio.
- **Bloqueo optimista**: el `LockVersion` ya lo gestiona la persistencia, con su 409. Nadie lo toca.
- **`version` declarado por el diseño ≠ `LockVersion`**: un `version` de dominio lo incrementa el agregado en
  cada método mutador observable.
- **Orden de las guardas**: `preconditions`/`rules` en el orden del diseño.
- **Proyección de la respuesta**: el DTO expone **exactamente** los campos del `output` de la operación.
- **Convenciones de determinación**: orden de las colecciones (y su desempate), formato de fechas, escala y
  redondeo de los importes, ausencia vs. nulo y sensibilidad a mayúsculas son contrato observable.
  Implementarlas de otro modo hace que este servidor deje de ser equivalente a los de keel-spring y keel-nest.
- **Wiring HTTP**: si la ruta, el status, el `Location` o los parámetros generados no coinciden con
  `api.keel.yaml`, es un defecto del scaffolding — repórtalo, no lo compenses.

## Revisión mecánica final (una pasada, al terminar el código)

Defectos que compilan y solo se ven ejercitando el servidor; recórrelos aunque nada los marque:

- **Ningún `double` ni `float` en un importe.** Busca `double`, `float`, `(double)`, `Convert.ToDouble` y
  `Math.Round(` sobre algo que venga de un `decimal`: son la precisión perdida. Y ningún `Math.Round(x, n)` sin
  modo: redondea al par, no `AwayFromZero`.
- **Asincronía rota.** Toda llamada a un puerto lleva `await` y recibe el `CancellationToken`. Un `.Result` o un
  `.Wait()` bloquea un hilo; una tarea sin esperar se ejecuta FUERA de la transacción del mediator (que ya se
  confirmó) y su error no llega a ningún manejador.
- **Ciclos en los mappers**: el mapeo de una entidad hija no invoca el del padre.
- **Ningún `Todo.Value(...)` ni `NotImplementedException` en lo que el diseño usa**: build los dejó donde no supo
  derivar algo; uno vivo es un 500 en el primer escenario que pasa por ahí.
- **Vocabulario del contrato**: cada campo que `validation-scenarios.md` menciona en una respuesta existe con ese
  nombre exacto en el DTO (`mapping.md` § Auditoría de consistencia del contrato).

## Un `Then` con PLAZO es una aserción

Cuando el `Then` acota el tiempo («llega en menos de 10 s»), ese número es parte de lo que se afirma. **La
espera de la prueba no puede ser mayor que el plazo del `Then`**. Si el mecanismo necesita más, es un hallazgo
(`culprit: design` si el plazo es irreal, `culprit: code` si el mecanismo no cumple), no un motivo para relajar la
aserción. Esperar menos sí es legítimo.
