# Troubleshooting

## «Transaction numbers are only allowed on a replica set member or mongos»

El servidor no es miembro de un replica set, o el conjunto no se ha iniciado.

```bash
docker exec <servicio>-db mongosh -u <db> -p changeme --authenticationDatabase admin \
  --quiet --eval 'rs.status().ok'
```

- Lanza → el conjunto no existe. El healthcheck del compose lo inicia; si no ha
  corrido, `docker compose -f infra/docker-compose.yaml up -d` y espera a `healthy`.
- Devuelve `1` pero la app sigue fallando → la app no está hablando con ese
  contenedor (revisa la URI del perfil activo).

Ojo: un `ping` en verde **no** descarta esto. Por eso `infra/validate-infra.sh`
sondea `rs.status()` y no un ping.

## El contexto no arranca: `NoSuchBeanDefinitionException: PlatformTransactionManager`

Falta `MongoTransactionConfig`, o alguien le quitó el bean. Spring Boot **no**
autoconfigura un gestor de transacciones con `spring-boot-starter-data-mongodb`, y el
`UseCaseMediator` lo exige. No es opcional: ver `transactions.md`.

## La app escribe, pero `mongosh` no encuentra los documentos por id

Casi siempre es la representación de UUID. Sin `uuidRepresentation=standard` en la
URI, el driver escribe el subtipo *legacy* (bytes permutados): la app se entiende
consigo misma, pero el mismo id se ve distinto desde cualquier otro cliente.

```javascript
db.inspection_reports.findOne({}, { _id: 1 })   // ¿BinData(3, …) o BinData(4, …)?
```

`BinData(4, …)` es el estándar; `BinData(3, …)` es legacy. Si ya hay datos escritos
con la representación equivocada, cambiar la URI **no** los convierte: hay que
reescribirlos o vaciar la base (`bash infra/reset-db.sh --schema`).

## La app conecta desde el contenedor pero no desde el host (o al revés)

Split-horizon. El miembro del replica set se anuncia como `db:27017`, que es un
nombre de la red de compose:

- Desde el **host** (perfil `local`, `./gradlew bootRun`) hace falta
  `directConnection=true`, o el driver intenta resolver `db` y se queda colgado.
- Desde **dentro** de la red (`deploy/`) conviene `replicaSet=rs0`.

Build ya deja cada perfil con el suyo. Si has tocado la URI, es lo primero que hay
que mirar.

## `E11000 duplicate key` que sale como 409 genérico en vez del error del diseño

El `ApiExceptionHandler` traduce buscando el **nombre del índice** dentro del mensaje
del driver. Que no lo encuentre significa una de tres:

1. El índice se creó con otro nombre — casi siempre porque alguien encendió
   `auto-index-creation` y Spring lo nombró a su manera.
2. El índice no está en `MongoIndexConfig` (lo creó un `mongosh` a mano).
3. El diseño no declara ese error, y entonces el genérico es lo correcto.

`bash infra/export-indexes.sh` y compara. Ver `indexes.md`.

## Un listado hace una consulta por elemento

Busca `@DBRef`. Es la causa habitual y no lo genera build: cada referencia es una
consulta del cliente. Sustitúyelo por el `UUID` + el `<X>RefResolver` por lote, o por
`$lookup` si hace falta filtrar/ordenar (`read-queries.md`).

## `BSONObjectTooLarge` o documentos que crecen sin cota

El límite es 16 MB por documento, y como el agregado es el documento, ese límite cae
sobre la frontera del agregado. No lo resuelvas sacando la colección hija a otra
colección con un id: eso parte una raíz en dos sin decirlo. Es una pregunta para el
diseño — ver `document-mapping.md` § *El límite de 16 MB*.

## Los escenarios `FL-*` ven datos del flujo anterior

`infra/reset-db.sh` vacía los documentos de todas las colecciones y **preserva los
índices**, que es lo correcto: los índices son el esquema aquí, y recrearlos en cada
flujo sería el error simétrico a truncar `flyway_schema_history` en la rama
relacional.

Si lo que sobrevive son índices con la forma vieja tras regenerar el modelo, ahí sí:
`bash infra/reset-db.sh --schema` borra la base entera y `MongoIndexConfig` los
recrea en el siguiente arranque.

## El perfil `test` «pasa» algo que en integración falla

Flapdoodle arranca *standalone*, así que en `test` el gestor de transacciones es un
no-op: no hay atomicidad que comprobar. Cualquier escenario sobre transaccionalidad
va en `src/integrationTest/`, contra la infra real.
