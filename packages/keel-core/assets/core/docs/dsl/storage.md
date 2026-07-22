# Capa `storage` — almacenamiento de archivos (opcional)

Archivo: `specs/<servicio>/storage.keel.yaml` · Schema: [`schema/storage.schema.json`](../../schema/storage.schema.json)

Dónde y cómo se guardan los archivos binarios del servicio (fotos de producto, PDFs de factura, adjuntos…). Agnóstica del proveedor: se declaran **buckets lógicos** con sus políticas, nunca el producto (S3, MinIO, GCS, Azure Blob…). El proveedor concreto se decide al generar. Un servicio que no maneja archivos no declara esta capa.

```yaml
buckets:
  productImages:
    description: Fotos de producto mostradas en el catálogo.
    visibility: public                    # private | public (default private)
    allowedContentTypes: [image/png, image/jpeg, image/webp]
    maxSizeMb: 5
  invoices:
    description: Facturas en PDF asociadas a un pedido.
    visibility: private                   # requiere URL firmada o acceso mediado
    allowedContentTypes: [application/pdf]
    maxSizeMb: 10
```

- Cada bucket declara qué se le permite guardar: `allowedContentTypes` (tipos MIME, obligatorio) y `maxSizeMb` (tamaño máximo por archivo).
- `visibility`: `private` (default) exige URLs firmadas o lectura mediada por el servicio; `public` permite lectura directa.
- Los nombres de bucket van en `camelCase`; son referencias lógicas, no nombres físicos del proveedor.

## Cómo se referencia un archivo desde el dominio

Un campo de entidad (o de un value object / payload) usa el tipo base `file` y apunta a un bucket con `bucket`:

```yaml
# domain.keel.yaml
entities:
  Product:
    fields:
      photo: { type: file, bucket: productImages }
```

- `file` es un tipo base más (como `string` o `uuid`), pero **exige** `bucket` y ese bucket debe existir en `storage: buckets` — `keel validate` lo comprueba (referencia cruzada). Sin capa `storage` declarada, un campo `file` es un error.
- Un bucket declarado que ningún campo `file` referencia produce un warning (bucket huérfano).

## Qué NO va aquí

- La representación en el dominio del archivo (qué entidad lo tiene) → capa `domain` (campo `file`).
- El producto concreto de almacenamiento (S3/MinIO/GCS), credenciales y endpoints → se deciden al **generar**, nunca en el spec.
- Errores de subida (`FILE_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`…) que expone una operación → capa `use-cases` (`errors`).
