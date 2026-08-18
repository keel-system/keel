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
    signedUrlTtlSeconds: 900              # cuánto vale ese enlace firmado
```

- Cada bucket declara qué se le permite guardar: `allowedContentTypes` (tipos MIME, obligatorio) y `maxSizeMb` (tamaño máximo por archivo).
- `visibility`: `private` (default) exige URLs firmadas o lectura mediada por el servicio; `public` permite lectura directa. **La decide el diseñador**, no el agente: con `public` la URL es la única protección, y con `private` alguna operación tiene que producir el acceso de lectura o el archivo es inaccesible por contrato. Ejes de decisión: `references/structural-decisions.md` de la skill `keel-design` §3.10.
- `signedUrlTtlSeconds` (solo con `private`): **cuánto vale la URL firmada** con la que se lee su contenido. Es contrato con quien la recibe —cuánto tiempo tiene para descargar, y durante cuánto le sirve a quien se la reenvíe—, no un ajuste del proveedor: una ventana larga convierte el enlace en acceso permanente para el que lo comparta, y una corta rompe descargas legítimas. `keel validate` avisa si un bucket `private` no la declara, porque sin ella la elige quien construya y no queda escrita en ninguna parte. En un bucket `public` no aplica: no hay firma que caducar.
- Los nombres de bucket van en `camelCase`; son referencias lógicas, no nombres físicos del proveedor.

`visibility` decide además **qué publica el contrato**, sin que haya que declararlo aparte: un campo `file` de bucket `public` viaja en las **respuestas HTTP** como URL absoluta (`format: uri` en el OpenAPI derivado), y uno de bucket `private` como la key. En los **eventos** (`messaging`) viaja siempre la key, sea cual sea la visibilidad: una URL caduca, ata el mensaje al proveedor de storage y se rompe al cambiar de bucket, mientras que una respuesta HTTP se consume en el acto.

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
