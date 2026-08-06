# Mapeo domain ↔ documento

## La regla que lo explica todo: el agregado es el documento

La raíz de agregado es una colección. Sus entidades internas **van dentro** de su
documento, como objetos y arrays. No tienen colección propia, ni `_id` que Mongo
indexe, ni forma de consultarse por separado.

| Diseño | Documento |
|---|---|
| campo escalar | `@Field(name = "<snake>")` |
| campo `list: true` | array del propio documento |
| value object | subdocumento anidado (`XxxDocument`) |
| value object **dentro** de otro | otro subdocumento — sin decisión que tomar |
| entidad hija (`one-to-many` interna) | `List<HijaDocument>` anidada |
| entidad hija (`one-to-one` interna) | `HijaDocument` anidada |
| back-reference de la hija a la raíz | **no existe**: era un artefacto de la clave ajena |
| relación a **otro** agregado | `UUID <rel>Id`, y nada más |
| `optimisticLocking` | `@Version Long lockVersion` en la raíz |

Build genera todo eso. Lo que sigue es para lo que no cubre.

## Nunca `@DBRef`

`@DBRef` parece un join y no lo es: el driver hace **una consulta por referencia**,
en el cliente, sin transacción y sin control de tu parte. Un listado de 100
documentos con un `@DBRef` son 101 consultas — el N+1 que
`{{keel:docs}}/conventions/read-composition.md` prohíbe, escrito con otra sintaxis.

Y aparte del coste, rompe la frontera del agregado: convierte «este agregado guarda
el id de aquel» en «este agregado carga aquel», que es exactamente lo que el diseño
separó.

Lo correcto es el `UUID` que build ya genera, resuelto por lote con el
`<X>RefResolver` o, si hace falta filtrar/ordenar por el otro agregado, con
`$lookup` en un adaptador de lectura (`read-queries.md`).

## `BigDecimal` siempre con `DECIMAL128`

```java
@Field(name = "amount", targetType = FieldType.DECIMAL128)
private BigDecimal amount;
```

Sin `targetType`, el driver serializa el `BigDecimal` como **String**: toda
comparación y todo orden en la base pasan a ser lexicográficos (`"10" < "9"`) y una
suma en agregación es imposible. Build lo pone en todos los campos `decimal`; si
añades uno a mano, ponlo tú. Es la precisión numérica que exige
`{{keel:docs}}/constitution.md`.

## Lo que la base ya no hace cumplir

En la rama relacional, `required` era `NOT NULL` y `maxLength` era `varchar(n)`: la
base rechazaba el documento mal formado aunque el código fallara. Aquí no hay
esquema, así que **la única defensa es la Bean Validation del borde**, y un
documento escrito por otra vía (un script, una migración) entra tal cual.

Si esa garantía es un requisito, se recupera con un validador de colección:

```javascript
db.runCommand({
  collMod: "inspection_reports",
  validator: { $jsonSchema: { bsonType: "object", required: ["site_code", "inspected_on"] } },
  validationLevel: "moderate"
})
```

Es **tuning del agente, no generación**: build no lo emite a propósito, porque un
generador de esquema declarativo sería Flyway con otro nombre y con la misma deuda
(hay que versionarlo, aplicarlo y mantenerlo sincronizado con las entidades).
Añádelo solo si un escenario del diseño lo exige, y déjalo escrito en el README.

## El límite de 16 MB

Un documento no puede pasar de 16 MB, y como el agregado ES el documento, ese límite
cae sobre la frontera del agregado. Una colección hija sin cota —líneas de un pedido
que crecen sin fin, un log de eventos dentro de la raíz— es un diseño que va a
romper en producción, no un problema de mapeo.

Cuando aparezca, la salida **no** es sacarla a otra colección y enlazarla con un id:
eso convierte una raíz en dos sin decirlo. Es una pregunta para el diseño: si esa
colección tiene ciclo de vida propio, es otro agregado y hay que declararlo como tal
en `domain.keel.yaml`.

## Evolución de la forma de un documento

No hay migraciones aquí, y para los índices no hacen falta (`MongoIndexConfig` los
recrea). Para los **datos** sí, y hay dos caminos:

1. **Lectura tolerante** (preferido cuando basta): añadir un campo nuevo opcional no
   rompe nada — los documentos viejos lo leen como `null`. Sirve para añadir campos
   y para dejar de usar uno.
2. **Migración de datos** (cuando el campo cambia de nombre, de tipo o de sitio): un
   `updateMany` con `$rename`/`$set`, ejecutado como paso previo al despliegue. No lo
   metas en un `ApplicationRunner`: correría en cada arranque y en cada réplica.

Deja escrito en el README qué migración hace falta y en qué orden, igual que la rama
relacional deja el baseline.
