# Capa `service` — manifiesto (obligatoria)

Archivo: `specs/<servicio>/service.keel.yaml` · Schema: [`schema/service.schema.json`](../../schema/service.schema.json)

El manifiesto es el punto de entrada del diseño: identidad del servicio y declaración de las capas presentes. La CLI y las skills siempre parten de aquí.

```yaml
keel: "2.3"

service:
  name: product-catalog        # kebab-case
  version: 1.0.0               # semver del DISEÑO (no del código generado)
  description: Gestiona el ciclo de vida de productos y su organización en catálogos.
  domain: commerce
  # basedOn: billing@1.2.0    # linaje: servicio@versión del que se derivó (opcional)

# conventions:              # convenciones de determinación de todo el servicio (opcional)
#   nulls: omit             # un campo sin valor no viaja; `include` (default) lo pone a null

# parameters:               # parámetros de DESPLIEGUE del servicio (opcional)
#   currency:
#     type: string          # string | int | long | decimal | boolean
#     description: "Moneda en la que opera el catálogo (ISO 4217)."
#     constraints: { pattern: "^[A-Z]{3}$" }
#     testValue: EUR        # el valor con el que corren los perfiles de prueba
#     requiredInProduction: true   # default: en producción viene del entorno, sin default

layers:
  domain: domain.keel.yaml
  use-cases: use-cases.keel.yaml
  api: api.keel.yaml
  security: security.keel.yaml
  messaging: messaging.keel.yaml
  http-clients: http-clients.keel.yaml
  dependencies: dependencies.keel.yaml
  persistence: persistence.keel.yaml
  storage: storage.keel.yaml
```

Reglas:

- `domain` y `use-cases` son obligatorias; el resto se declara **solo si aplica** al servicio.
- Una capa opcional existe ⇔ está declarada en `layers` y su archivo existe (`keel validate` comprueba ambas direcciones).
- Los nombres de archivo son fijos (`<capa>.keel.yaml`): la clave declara la capa, no elige el nombre.
- La versión del diseño sube según semver del contrato: ver [methodology.md](../methodology.md).
- La plantilla siembra `description` con el prefijo `TODO:`; `keel validate` lo trata como placeholder pendiente (error sin `--wip`, aviso con `--wip`) hasta que se redacte la frase real.
- `basedOn` (opcional, formato `<servicio>@<versión>`) registra de qué diseño viene el servicio. Lo escriben los dos comandos que traen un diseño de fuera: `keel new <nuevo> --from <origen>`, que **deriva** (renombra y resetea la versión), y `keel registry get <diseño>`, que **adopta** sin cambios. En el segundo caso el `basedOn` coincide con el propio servicio (`catalog@0.3.0` en un servicio llamado `catalog` v0.3.0), y se lee literalmente: «esto *es* `catalog@0.3.0`» — sin ese sello, la primera evolución sería un fork sin rastro de su procedencia. Es linaje histórico, no acoplamiento: el servicio evoluciona libre. Cuando además hay renombrado (derivación), `/keel-design` lo usa para arrancar en modo derivación y entrevistar solo sobre lo que cambia.
- `parameters` (opcional) declara los **parámetros de despliegue** del servicio: un valor único para todo él que **no es dato de negocio ni entrada de ninguna operación** y del que sí depende el comportamiento —la moneda en la que opera el catálogo, la zona horaria con la que se corta un día—. Cada uno lleva `type` (un escalar: lo que necesita estructura es diseño, no configuración), `description`, opcionalmente `constraints` (se comprueban al **arrancar**, no en la primera petición que use el valor), `testValue` —el que usan los perfiles de prueba, y es lo que hace ejercitables los escenarios que dependen de él—, `default` y `requiredInProduction` (por defecto `true`: en producción el valor viene del entorno **sin** default, así que un despliegue que lo olvide no arranca; con un default silencioso el servicio opera con un valor que nadie eligió).
  - De un parámetro declarado cuelgan cuatro cosas que tienen que decir lo mismo, y el generador las emite juntas: el fragmento de configuración por perfil, el objeto tipado que lo transporta al código, la variable de entorno del despliegue y la comprobación de sus cotas al arrancar. Mientras solo pudo decirse en prosa —una `rule` del dominio: «la currency de price es la moneda del catálogo, un parámetro de despliegue único para todo el servicio»— las cuatro las elegía quien generase, y el contrato operativo no quedaba escrito en ninguna parte. `keel validate` avisa (`CHK-SERVICE-PARAM-UNBACKED`) cuando la prosa nombra un parámetro de despliegue y el manifiesto no declara ninguno.
  - Lo que **no** es un parámetro: un valor que cambia por petición (es entrada), uno que depende del inquilino (es dato), y cualquier cosa con estructura (es diseño). Tampoco la configuración de la infraestructura —URLs, credenciales, tamaños de pool—, que la elige el stack y no el diseño.
- `conventions` (opcional) recoge las **convenciones de determinación** que valen para todo el servicio y cambian el código: hoy, `nulls` (`omit` \| `include`, default `include`) — si un campo sin valor aparece en las respuestas y en los payloads de evento. Antes solo podía decirse en la sección «Convenciones de determinación» de `validation-scenarios.md`, que es prosa y el generador no lee; `keel validate` avisa (`CHK-SCEN-CONVENTION-UNBACKED`) cuando esa prosa la declara y el manifiesto no. No toca el cuerpo de error, que tiene forma fija.
