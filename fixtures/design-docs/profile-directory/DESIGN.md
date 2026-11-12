# profile-directory — Documento de diseño

> specs/profile-directory v1.1.0. Diseño cerrado al preparar la corrida del incremento 8 de keel-nest
> (2026-10-07) y ampliado en la v1.1.0 (DSL 2.28, incremento 6 de PLAN-DSL-228-CICLO-DE-VIDA.md) con el
> correo, el borrado lógico, la restauración y la retención; las decisiones las tomó quien lo preparaba,
> por delegación del diseñador.

## 1. Propósito y alcance

Guarda la **ficha de contacto** del titular de un token, y solo la suya: quien llama la consulta, la
reemplaza, la borra y la restaura en `/me/card`, sin poder nombrar a nadie más. Es la silueta mínima de un
servicio cuya identidad del llamante sale de un **claim** del token (`sub`) y no del cuerpo, y el contraste
del ciclo de vida del dato: qué es personal, qué significa borrar y cuánto vive lo borrado.

Queda fuera, a propósito: la consulta de fichas ajenas por cualquier rol, el consumo desde un navegador
(no hay `cors`) y la supresión del interesado como operación propia (RGPD art. 17). Motivos en § 7.

## 2. Modelo de dominio

| Entidad | Agregado | Qué es |
|---|---|---|
| `ContactCard` | raíz | La ficha de un titular: `subject` es su `sub` (clave natural, única entre fichas vivas), `displayName` su nombre visible (opcional, hasta 100 caracteres) y `email` su correo de contacto (opcional, hasta 254 caracteres, único entre fichas vivas). |

Campos generados: `id` (uuid del servidor). `subject` no llega nunca del cliente: lo estampa el servidor
desde el token. Los tres campos que hablan del titular (`subject`, `displayName`, `email`) son **datos
personales**: ningún log ni traza los lleva, y figuran en `docs/keel/personal-data.md` del proyecto
generado. Sin ciclo de vida de negocio: la ficha está viva o borrada, y esa marca la pone el generador.

## 3. Invariantes y reglas clave

- Una ficha viva por titular (clave natural `subject`) y un correo por ficha viva (`email` único).
- `saveMyCard` crea la ficha la primera vez y la **reemplaza entera** después: un `displayName` o un
  `email` que no llega se queda a `null`, no conserva el anterior.
- Borrar es **lógico**: la ficha borrada no existe para la API (404), y su `subject` y su `email` quedan
  libres para una ficha nueva.
- `restoreMyCard` devuelve la ficha borrada más reciente durante **30 días**, con su `id` y sus datos; no
  desplaza a nadie: si su `subject` o su `email` los ocupa otra ficha viva, responde el 409 de esa unicidad.
- La **retención** purga cada ficha borrada a los 30 días del borrado; la ficha viva no caduca.
- La identidad la estampa el servidor desde el claim `sub` (`authentication.callerIdentity`): un
  `callerSubject` en el cuerpo se ignora.

## 4. Qué hace

| Operación | Ruta | Éxito | Errores |
|---|---|---|---|
| `getMyCard` | `GET /api/v1/me/card` | `200` con la ficha | `404 CARD_NOT_FOUND` si el titular no tiene ficha viva |
| `saveMyCard` | `PUT /api/v1/me/card` | `200` con la ficha creada o reemplazada | `400 VALIDATION_ERROR` (cotas), `409 EMAIL_ALREADY_EXISTS`, `409 CARD_ALREADY_EXISTS` (carrera de la primera escritura) |
| `deleteMyCard` | `DELETE /api/v1/me/card` | `204` | `404 CARD_NOT_FOUND` si no tiene ficha viva |
| `restoreMyCard` | `POST /api/v1/me/card/restore` | `204` | `404 CARD_NOT_FOUND` (nada borrado), `409 CARD_NOT_RESTORABLE` (más de 30 días), `409 CARD_ALREADY_EXISTS` / `EMAIL_ALREADY_EXISTS` (clave ocupada) |

Las cuatro exigen un token válido (`401 UNAUTHENTICATED` sin él) con el permiso `card:self`, que otorga el
rol `card-holder` (`403 ACCESS_DENIED` sin él).

## 5. Fronteras e integraciones

Un proveedor de identidad OIDC (Keycloak o Cognito según el stack) emite los tokens; el servicio solo
los valida. No publica ni consume eventos y no llama a nadie. La purga la ejecuta el cronómetro del
servicio (un recurrente, una sola réplica por pasada).

## 6. Decisiones de diseño (qué / por qué)

- **Sin idempotencia**: `saveMyCard` reemplaza, y borrar o restaurar dos veces da `404` sin efecto.
- **Gana el último** entre dos reemplazos simultáneos (`optimisticLocking: none`): solo el titular
  escribe su ficha, y lo último que guardó es lo que quiere ver.
- **La primera escritura simultánea** del mismo titular la arbitra la clave natural: la que pierde
  recibe `409 CARD_ALREADY_EXISTS` y reintentarla da el resultado esperado.
- **`200` también al crear**: el recurso es siempre `/me/card`, no hay ubicación nueva que anunciar.
- **Borrado lógico con 30 días para arrepentirse**, y purgado a los 30 días: la ficha es enteramente
  datos personales, así que lo borrado no se conserva más allá de la ventana en la que se puede
  restaurar. Una ficha borrada da `404`, nunca `410`: el cuerpo no revela que existió.
- **El correo compara exacto**: `ana@` y `Ana@` son correos distintos; nada se normaliza.
- **Sin caché ni auditoría**: el titular lee lo que acaba de hacer, y el autor es siempre él.

## 7. Ficha de reutilización

### Contrato estable vs adaptable

Estable: las cuatro rutas, la forma `{id, subject, displayName, email}` con `null` explícito, los `code`
y el `204` sin cuerpo del borrado y la restauración.
Adaptable: el proveedor de identidad, el claim que identifica al titular, las cotas de los campos y los
dos plazos de 30 días.

### Supuestos y limitaciones

- La supresión del interesado (borrar de verdad ya, sin ventana) no es una operación: hoy la cumple la
  retención a los 30 días del borrado.
- Ningún rol lee fichas ajenas: un back-office necesitaría sus propias operaciones.
- Sin `cors`: lo consumen aplicaciones con backend propio.

### Cómo reutilizarlo

Cambiar el claim de `callerIdentity.from.name` (por ejemplo, a un identificador de empleado), añadir a
`ContactCard` los campos de la ficha que haga falta (marcando `personal` los que hablen de la persona) y
ajustar `restorableFor` y `retention` a lo que pida el negocio. La clave natural sigue siendo el titular.
