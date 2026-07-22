# Capa `service` — manifiesto (obligatoria)

Archivo: `specs/<servicio>/service.keel.yaml` · Schema: [`schema/service.schema.json`](../../schema/service.schema.json)

El manifiesto es el punto de entrada del diseño: identidad del servicio y declaración de las capas presentes. La CLI y las skills siempre parten de aquí.

```yaml
keel: "2.0"

service:
  name: product-catalog        # kebab-case
  version: 1.0.0               # semver del DISEÑO (no del código generado)
  description: Gestiona el ciclo de vida de productos y su organización en catálogos.
  domain: commerce

layers:
  domain: domain.keel.yaml
  use-cases: use-cases.keel.yaml
  api: api.keel.yaml
  security: security.keel.yaml
  messaging: messaging.keel.yaml
  http-clients: http-clients.keel.yaml
  persistence: persistence.keel.yaml
```

Reglas:

- `domain` y `use-cases` son obligatorias; el resto se declara **solo si aplica** al servicio.
- Una capa opcional existe ⇔ está declarada en `layers` y su archivo existe (`keel validate` comprueba ambas direcciones).
- Los nombres de archivo son fijos (`<capa>.keel.yaml`): la clave declara la capa, no elige el nombre.
- La versión del diseño sube según semver del contrato: ver [methodology.md](../methodology.md).
- La plantilla siembra `description` con el prefijo `TODO:`; `keel validate` lo trata como placeholder pendiente (error sin `--wip`, aviso con `--wip`) hasta que se redacte la frase real.
