# profile-directory — Documento de diseño

> specs/profile-directory v1.0.0. Diseño cerrado al preparar la corrida del incremento 8 de keel-nest
> (2026-10-07); las decisiones las tomó quien la preparaba, por delegación del diseñador.

## 1. Propósito y alcance

Guarda la **ficha de contacto** del titular de un token, y solo la suya: quien llama la consulta y la
reemplaza en `/me/card`, sin poder nombrar a nadie más. Es la silueta mínima de un servicio cuya
identidad del llamante sale de un **claim** del token (`sub`) y no del cuerpo.

Queda fuera, a propósito: el borrado de la ficha (el titular puede dejarla sin nombre), la consulta de
fichas ajenas por cualquier rol y el consumo desde un navegador (no hay `cors`). Motivos en § 7.

## 2. Modelo de dominio

| Entidad | Agregado | Qué es |
|---|---|---|
| `ContactCard` | raíz | La ficha de un titular: `subject` es su `sub` (clave natural, única) y `displayName` su nombre visible, opcional y de hasta 100 caracteres. |

Campos generados: `id` (uuid del servidor). `subject` no llega nunca del cliente: lo estampa el servidor
desde el token. Sin ciclo de vida: la ficha existe o no existe.

## 3. Invariantes y reglas clave

- Una ficha por titular: la clave natural es `subject`.
- `saveMyCard` crea la ficha la primera vez y la **reemplaza entera** después: un `displayName` que no
  llega la deja con `null`, no conserva el anterior.
- La identidad la estampa el servidor desde el claim `sub` (`authentication.callerIdentity`): un
  `callerSubject` en el cuerpo se ignora.

## 4. Qué hace

| Operación | Ruta | Éxito | Errores |
|---|---|---|---|
| `getMyCard` | `GET /api/v1/me/card` | `200` con la ficha | `404 CARD_NOT_FOUND` si el titular aún no tiene ficha |
| `saveMyCard` | `PUT /api/v1/me/card` | `200` con la ficha creada o reemplazada | `400 VALIDATION_ERROR` (nombre de más de 100 caracteres) |

Las dos exigen un token válido (`401 UNAUTHENTICATED` sin él) con el permiso `card:self`, que otorga el
rol `card-holder` (`403 ACCESS_DENIED` sin él).

## 5. Fronteras e integraciones

Un proveedor de identidad OIDC (Keycloak o Cognito según el stack) emite los tokens; el servicio solo
los valida. No publica ni consume eventos y no llama a nadie.

## 6. Decisiones de diseño (qué / por qué)

- **Sin idempotencia en `saveMyCard`**: es un `PUT` que reemplaza; repetirlo deja el mismo estado.
- **Gana el último** entre dos reemplazos simultáneos (`optimisticLocking: none`): solo el titular
  escribe su ficha, y lo último que guardó es lo que quiere ver.
- **La primera escritura simultánea** del mismo titular la arbitra la clave natural: la que pierde
  recibe `409 CONTACT_CARD_SUBJECT_ALREADY_EXISTS` y reintentarla da el resultado esperado.
- **`200` también al crear**: el recurso es siempre `/me/card`, no hay ubicación nueva que anunciar.
- **Sin caché ni auditoría**: el titular lee lo que acaba de guardar, y el autor es siempre él.

## 7. Ficha de reutilización

### Contrato estable vs adaptable

Estable: las dos rutas, la forma `{id, subject, displayName}` con `null` explícito y los `code`.
Adaptable: el proveedor de identidad, el claim que identifica al titular y la cota del nombre.

### Supuestos y limitaciones

- No hay borrado: entra con una operación propia cuando el negocio lo pida (derecho de supresión).
- Ningún rol lee fichas ajenas: un back-office necesitaría sus propias operaciones.
- Sin `cors`: lo consumen aplicaciones con backend propio.

### Cómo reutilizarlo

Cambiar el claim de `callerIdentity.from.name` (por ejemplo, a un identificador de empleado) y añadir
a `ContactCard` los campos de la ficha que haga falta. La clave natural sigue siendo el titular.
