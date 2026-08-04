# Migraciones de esquema (Flyway)

Build ya dejó el **mecanismo** completo: dependencias (`flyway-core` + el módulo
del dialecto), el directorio `src/main/resources/db/migration/`, la config por
perfil y los dos perfiles auxiliares (`schema-export`, `migrations`). Lo que
falta es el contenido: **el baseline**. Sin él, `develop` y `production` no
arrancan — ahí Hibernate solo valida (`ddl-auto: validate`) y nadie crea tablas.

Es lo último que haces con la persistencia, no lo primero: el baseline describe
las entidades **ya finales**, después de resolver los `// TODO (agente)` y de que
los escenarios `FL-*` estén en OK. Mientras iteras, en `local` manda
`ddl-auto: update` y Flyway está apagado.

## 1. Exportar el DDL

No se escribe a mano: se exporta de las propias entidades, con el dialecto real
del stack, para que esquema y mapeo no puedan divergir.

```bash
docker compose -f infra/docker-compose.yaml up -d   # el export conecta a la BD
bash infra/export-schema.sh                         # → build/schema/baseline.sql
```

El script arranca la app con `PROFILE=local,schema-export` (Hibernate escribe el
DDL al construir el `EntityManagerFactory` y no toca la BD), espera el archivo y
para el proceso. Si falla, el log queda en `build/schema/export.log`.

## 2. Revisar el SQL exportado

Hibernate acierta en la estructura, pero el archivo es **tu** entregable: pásale
esta checklist antes de aceptarlo.

- **Tablas completas**: una por cada `XxxJpa` persistida, las tablas de elementos
  (`<entidad>_<campo>` de los `@ElementCollection`) y — si el diseño las usa —
  `outbox_event` y `processed_event`. Una tabla que falte aquí es una tabla que
  faltará en producción.
- **Constraints e índices con su nombre del diseño**: `uk_<tabla>_natural` (clave
  natural), `uk_<tabla>_<campo>` (campos `unique`) e `idx_<tabla>_<campos>`
  (`indexes` de `persistence.keel.yaml`). El `ApiExceptionHandler` traduce la
  violación **por nombre de constraint**: si el nombre cambia, el error declarado
  del diseño se degrada a un 409 genérico. El propio `export-schema.sh` comprueba
  cuáles faltan y los lista al terminar (`AVISO: el DDL exportado no nombra estas
  constraints…`): Hibernate suele colapsar las multi-columna en un `unique (...)`
  inline sin nombre, y hay que reescribirlas a
  `constraint uk_<tabla>_natural unique (...)` antes de copiar el archivo. Ese
  aviso no es informativo: es trabajo pendiente.
- **Nullabilidad**: `not null` en los campos `required` y en las FK de relaciones
  requeridas. Es la última línea de defensa de un invariante.
- **FK entre agregados: nunca están en el DDL exportado, y a veces tienen que
  estar en el baseline.** Una referencia a otro agregado es una columna `UUID`
  plana sin asociación JPA, así que Hibernate no emite ninguna FK y
  `export-schema.sh` —que parte de las entidades— tampoco puede inventarla.
  Repasa el diseño: por cada error del tipo `<X>_IN_USE`, o cada `rule` que llame
  «restricción de integridad» a una referencia entre agregados, la comprobación
  del handler es solo el mensaje amable — la garantía es la FK, y la añades tú:

  ```sql
  ALTER TABLE products ADD CONSTRAINT fk_products_brand
      FOREIGN KEY (brand_id) REFERENCES brands (id);
  ```

  Registra ese nombre de constraint en el `CONSTRAINT_TO_ERROR` del
  `ApiExceptionHandler`, o la violación se degrada a un 409 genérico en vez del
  `code` declarado. El razonamiento completo —incluido cuándo **no** ponerla (el
  diseño acepta la ventana explícitamente)— está en
  `{{keel:docs}}/conventions/mapping.md § Cuando el diseño llama «restricción de
  integridad» a una referencia entre agregados`.
- **Tipos del dialecto**: revisa `dialects/<database>.md` antes de aceptar los
  tipos de columnas no triviales (JSON/jsonb, UUID, texto largo, `decimal` con
  precisión/escala). Ajústalos a mano si el default de Hibernate no es el que
  quieres en producción — pero entonces ajusta también la entidad
  (`columnDefinition`), o `validate` fallará.
- **Ruido fuera**: si el exportador emite `drop table` / `drop constraint` al
  principio, bórralos. Una migración nunca destruye lo que va a crear.

Cópialo entonces como `src/main/resources/db/migration/V1__baseline_schema.sql`.

## 3. Doble check estático

El baseline se entrega **verificado, no probado**: la prueba en vivo es del
diseñador (§4). Lo que sí haces son dos pasadas independientes sobre el
`V1__baseline_schema.sql` ya copiado. Ninguna enciende nada — ni la app, ni un
contenedor nuevo.

**Pasada 1 — fidelidad al export.**

```bash
diff build/schema/baseline.sql src/main/resources/db/migration/V1__baseline_schema.sql
```

Toda diferencia tiene que ser una edición **deliberada y justificable**: las
constraints renombradas a su nombre del diseño, las FK entre agregados añadidas,
los `drop table`/`drop constraint` eliminados, los tipos del dialecto ajustados.
Una diferencia que no sepas explicar no es una mejora: es algo que rompiste al
editar. El `AVISO:` que imprimió `export-schema.sh` es insumo de esta pasada.

**Pasada 2 — contra las fuentes del diseño**, sin mirar el export. Recorre las
entidades `XxxJpa` finales, `specs/persistence.keel.yaml` y `specs/domain.keel.yaml`
y comprueba **sobre el SQL**:

- una `create table` por cada `XxxJpa` persistida, más las `<entidad>_<campo>` de
  los `@ElementCollection` y `outbox_event`/`processed_event` si el diseño los usa;
- los nombres `uk_*`/`idx_*` declarados, todos presentes;
- `not null` en cada campo `required` y en las FK de relaciones requeridas;
- cada constraint nombrada en el `CONSTRAINT_TO_ERROR` del `ApiExceptionHandler`
  existe en el archivo, **y al revés**: ninguna FK entre agregados añadida se quedó
  sin su entrada.

Son dos y no una porque cazan cosas distintas: la primera ve lo que rompiste
editando; la segunda, lo que un DDL exportado nunca delata — una tabla que falta
porque la entidad no quedó anotada, una FK entre agregados olvidada.

## 4. La prueba en vivo la hace el diseñador

Fuera de la generación, a mano, antes del primer despliegue. El baseline solo está
**probado** si ha creado el esquema **desde cero**: contra una BD que Hibernate ya
pobló con `ddl-auto: update`, el `validate` pasaría sin haber ejercitado nada.

```bash
docker compose -f infra/docker-compose.yaml down -v   # borra el volumen: BD sin esquema
docker compose -f infra/docker-compose.yaml up -d
PROFILE=local,migrations ./gradlew bootRun            # Flyway crea, Hibernate valida
```

Arranque limpio = baseline correcto. Un fallo de `validate` aquí es exactamente
el fallo que tendrías en producción, con el mensaje que te dice qué columna o
tipo no coincide; se corrige el SQL y se repite.

El pase de calidad **no** ejecuta esto: borrar el volumen destruiría la base de
datos sobre la que corre su propia no-regresión (`./gradlew integrationTest`), y el
diseñador tiene que ver ese arranque con sus ojos antes de desplegar. Los comandos
quedan escritos en el `README.md` del proyecto (§ Despliegue en producción) y en el
`README.md` de `db/migration/`.

## Migraciones posteriores

- `V<n>__<snake_case>.sql` para cada cambio: `V2__add_product_sku_index.sql`.
  Numera hacia arriba, en inglés como todo identificador.
- **Nunca edites una migración ya aplicada** en algún ambiente: Flyway guarda su
  checksum y el arranque falla con «migration checksum mismatch». Lo que ya
  corrió solo se corrige con una migración nueva.
- `R__<snake_case>.sql` (repeatable, se reaplica al cambiar su contenido) solo
  para contenido idempotente: datos de referencia, vistas.
- Cambios destructivos (borrar o renombrar columna) en dos pasos, nunca en uno:
  añadir y rellenar primero, borrar en un despliegue posterior.

## Lo prohibido

- **`flyway clean`**: borra el esquema. Está deshabilitado en `production` y no
  se habilita.
- **`baseline-on-migrate` para tapar un desajuste**: marca como aplicado lo que
  no lo está. Si la BD tiene esquema previo legítimo, esa decisión es del
  operador, no tuya.
- **Relajar `ddl-auto` a `update` fuera de `local`** para que arranque: convierte
  a Hibernate en dueño del esquema y hace inútil todo lo anterior.
- **Migraciones en el perfil `test`**: está apagado a propósito (H2 con
  `create-drop`); el DDL exportado es del dialecto real y no aplica ahí.

## Interacción con `reset-db.sh`

`infra/reset-db.sh` vacía datos preservando el esquema **y** el historial:
excluye `flyway_schema_history` explícitamente. Si lo truncaras, el siguiente
arranque intentaría reaplicar `V1` sobre tablas existentes y fallaría. No
«mejores» el script eliminando esa exclusión.
