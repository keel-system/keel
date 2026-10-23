# Los bucles de build y de arranque (pasos 0d y 0e)

Dos bucles, cada uno con un tope de **6 intentos**. Cada intento es una fila en `sandbox/LOG.md` y cada cambio del entorno que sobreviva, una entrada en `environment.yaml#adaptations` con su motivo.

## 0d. Build

`bash sandbox/build.sh`. Fallos conocidos:

| Síntoma | Causa | Arreglo (adaptación del entorno) |
|---|---|---|
| Maven no resuelve un repositorio `http://` | Maven ≥ 3.8.1 bloquea http (`runtime.yaml#repositories[].risks: insecure-http`) | un `settings.xml` con mirror https, montado en el build |
| 404 de `jcenter.bintray.com` o `dl.bintray.com` | cerrados (`risks: sunset`) | mirror a Maven Central en `settings.xml` / `init.gradle` |
| 401 de `repo.spring.io/libs-release` | cerrado al anónimo desde 2022 (`risks: requires-auth`) | mirror a Maven Central; si un artefacto solo estaba allí, rechazo con motivo |
| `npm ERR! 404` de un paquete | despublicado | el lockfile del repo fija la versión; si no hay otra fuente, rechazo con motivo |
| `node-gyp` pide python | módulo nativo antiguo | python2 en la etapa de build (no en la de ejecución) |
| `apt-get` da 404 en una imagen antigua | Debian EOL | `archive.debian.org` en `sources.list` de la etapa de build |
| una prueba descarga binarios en el build | (flapdoodle, Puppeteer…) | primero comprueba si alguna prueba lo usa de verdad (en orders, ninguna); si sí, `-DskipTests` con motivo |
| registro privado (`runtime.yaml#registries[].private: true`) sin credenciales en el repo | — | **rechazo con motivo**: no hay otra entrada que el repo |

La red del build solo resuelve dependencias. Nunca la uses para buscar el proyecto, su documentación o sus respuestas: lo que no está en el repo no se sabe (principio 8).

## 0e. Arranque

`podman compose -f sandbox/compose.yaml up -d` y las dos sondas del juez a mano por el contenedor de la herramienta, hasta que respondan:

```bash
podman exec rec-<servicio>-tool curl -s -w '\n%{http_code}\n' http://<alias>:<puerto>/<lectura>
```

En Git Bash, `export MSYS_NO_PATHCONV=1` antes de cualquier `podman exec` con rutas.

Por orden:

1. **Variables que faltan**: `environment.yaml#config`, la que no tenga default y el código lea sin alternativa. El valor sale del repo (`.env.example`, el perfil de desarrollo, la CI) o es de prueba y lo dice. Ojo con el modo (`compared_with: [production]`): fuera de producción RealWorld ignoraba `MONGODB_URI` y conectaba a `localhost`. Elige un modo, declara cuál en las adaptaciones y no lo cambies entre rondas: el modo cambia los cuerpos de error.
2. **Esquema**: las migraciones de la app (`environment.yaml#assets` de tipo `migration`); si no hay, el que crea el ORM al arrancar; si tampoco, el derivado de las entidades, con procedencia `read`.
3. **Datos**: los seeds y fixtures del repo (`assets` de tipo `seed`, o un `contract-test` con `seeds: true`), o los que cree la propia API. Nunca datos de producción.

### Síntomas del motor equivocado

La app arranca y parece sana: por eso el juez mira lecturas y escrituras reales, y por eso el motor sale de la CI.

| Síntoma | Causa medida |
|---|---|
| toda consulta da 500 `Unsupported OP_QUERY command` y `/health` dice OK | driver de Mongo antiguo contra MongoDB ≥ 6.0 |
| solo fallan las escrituras en arrays (`Unknown modifier: $pushAll`) | mongoose 4 contra MongoDB ≥ 3.6 |
| un usuario nuevo recibe 422 «is already taken» | mongoose-unique-validator toma la consulta fallida por duplicado |
| reiniciar la app devuelve la base a su seed | el esquema lo crea el ORM al arrancar (`ddl-auto: create`): no reinicies la app entre el snapshot y las sondas |
| el juez de un PostgreSQL antiguo no ve la escritura | no lo uses: `verify` mide la huella del contenido, no los contadores de `pg_stat_user_tables` (en 9.4 llegan segundos tarde) |

## Al agotar el presupuesto

Para y escribe al humano: los intentos (la tabla del diario), el último fallo con su salida y la decisión que necesitas. No inventes la salida: un sandbox en rojo declarado vale más que uno en verde que miente.
