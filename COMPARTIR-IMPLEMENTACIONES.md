# Compartir implementaciones junto a los diseños del registry

> Plan de implementación futura. No implementado.

## Contexto

Hoy el registry comparte **diseños** y solo diseños: `specs/<slug>/` con sus capas, el sidecar
`design.yaml`, y un `index.json` que `keel registry` hojea y `keel new --from registry:<slug>`
deriva. Lo que sale de `keel-spring build` + `/keel-generate-spring` —un repo autosuficiente con
`specs/`, `docs/`, `.claude/` y `keel-stack.json` dentro— no tiene ningún camino de publicación:
`packages/keel-spring/README.md` habla de idempotencia, no de compartir, y no hay concepto de
implementación en ningún schema.

Eso deja sin capitalizar la parte más cara del método. Un diseño publicado dice *qué* hace un
servicio; nadie puede ver *cómo queda* construido, ni comprobar que alguien lo llevó hasta el final.

El objetivo es que un diseño publicado pueda **exhibir sus implementaciones** como evidencia
navegable, sin que el registry se convierta en un almacén de código y sin debilitar la regla de que
el diseño es la fuente de verdad y el código se regenera.

Tres decisiones ya tomadas, que fijan el alcance:

1. **Propósito: evaluar y aprender.** El consumidor hojea la implementación para decidir; su camino
   sigue siendo `keel new --from registry:<slug>` y regenerar. **No** se añade descarga de código a
   la CLI.
2. **Alojamiento: repo git propio, referenciado por URL.** El registry guarda metadatos, no fuentes.
   No se toca `downloadDesign()` ni el filtrado a `specs/<slug>/`.
3. **Trazabilidad: sello máquina-legible + comprobación.** Hoy `service.version` solo aparece en
   prosa (`readme.js:20`, `claude-md.js:139`, `gradle.js:83`): una implementación puede afirmar
   cualquier cosa. Se añade un sello verificable y una puerta de CI que lo contrasta.

## Diseño de la solución

Tres piezas, cada una utilizable por separado, en el orden en que deben construirse.

### 1. `specDigest()` en keel-core — la identidad verificable de un diseño

Nuevo `packages/keel-core/src/lib/spec-digest.js`, exportado desde `src/index.js` (lo consumen los
generadores, igual que `validateService` o `copyTree`).

```js
export function specDigest(dir)  // → { digest: 'sha256:<hex>', files: ['service.keel.yaml', ...] }
```

- Entrada: el manifiesto + **las capas declaradas** (reusar `loadService(dir).files`, que ya las
  resuelve) + `validation-scenarios.md` si existe — es el contrato de equivalencia y forma parte de
  lo que una implementación promete cumplir.
- **Excluye `design.yaml`** a propósito: es metadato de publicación, no diseño. Sin esa exclusión el
  digest del registry nunca casaría con el del workspace del autor, donde el sidecar no existe.
- Determinista y multiplataforma, con el mismo criterio que `design-index.js`: rutas POSIX ordenadas
  alfabéticamente, EOL normalizado a `\n`, BOM descartado. Se hashea `<ruta>\n<contenido>\n` por
  archivo sobre un único `createHash('sha256')`.

### 2. El sello en el proyecto generado — `keel-build.json`

`keel-spring build` escribe `keel-build.json` en la raíz del proyecto. **No** como módulo de
`GENERATORS` (`src/scaffold/index.js:50`): esos pasan por `writeFiles` sin `force` y un sello que no
se refresca es peor que no tenerlo. Va en `src/commands/build.js`, junto a los snapshots de `specs/`
y `docs/` (`build.js:151-173`), con `writeFiles([...], { force: true })` — **siempre se refresca**.

```json
{
  "stampVersion": 1,
  "generator": "keel-spring",
  "generatorVersion": "0.1.0",
  "dsl": "2.3",
  "service": { "name": "catalog", "version": "1.2.0" },
  "specDigest": "sha256:…",
  "stack": { "group": "…", "database": "postgresql", "broker": "kafka" }
}
```

- `generatorVersion` ← `packageVersion()` (`keel-spring/src/lib/assets.js:31`).
- `stack` ← `scaffold.stack`, el **normalizado** por `resolveStack()` (`scaffold/index.js:92`), no el
  archivo. Beneficio colateral: `keel-stack.json` se congela en el primer build y puede
  desincronizarse (`build.js:118-131`); el sello siempre refleja lo que de verdad se generó. Corregir
  esa desincronización queda **fuera de alcance**.
- El sello es transversal a generadores: la forma se documenta en
  `keel-core/assets/core/docs/building-a-generator.md` para que cualquier `keel-<tech>` futuro emita
  el mismo contrato.

### 3. `implementations` en el sidecar y en la ficha del registry

**Schema** — `packages/keel-core/assets/core/schema/design.schema.json` (tiene
`additionalProperties: false`, así que la propiedad debe declararse):

```yaml
implementations:
  - generator: keel-spring          # requerido, ^[a-z][a-z0-9-]*$
    repo: https://…/catalog-spring  # requerido, format: uri
    ref: v1.2.0                     # tag o commit; recomendado
    serviceVersion: 1.2.0           # requerido — la versión del diseño que implementa
    stack: [postgresql, kafka, keycloak]
    stamp: https://raw.…/keel-build.json   # opcional: habilita `registry verify`
    notes: …
```

**`buildIndex()`** (`design-index.js:167`) no cambia de forma: `metadata` ya copia el sidecar entero,
así que `implementations` viaja al `index.json` sin tocar la construcción de la entrada. Sí se añade
un **warning** cuando `implementations[].serviceVersion !== service.version` del manifiesto — un
aviso al indexar hace salir `keel index` con código 1 (`index-cmd.js:100`), o sea que es puerta de CI
del registry sin red y sin trabajo nuevo.

> **`INDEX_SCHEMA_VERSION` no sube.** El índice gana claves dentro de `metadata`, no cambia de forma;
> `parseIndex()` solo pone techo (`registry-source.js:86-104`), y las CLIs anteriores ignoran lo que
> no conocen. Subirlo sería breaking para todos los consumidores sin motivo.

**`keel registry show`** (`registry.js:132`) gana una sección tras "Documentación":

```
Implementaciones:
  • keel-spring v1.2.0 — postgresql · kafka · keycloak
    https://github.com/x/catalog-spring @ v1.2.0
```

Con marca en rojo cuando `serviceVersion` va por detrás de `service.version` del diseño: la
implementación existe pero quedó atrás, y quien evalúa debe saberlo antes de mirarla.

**`keel registry verify <slug>`** (nuevo subcomando en `registry.js`, registrado en `cli.js`): por
cada entrada con `stamp`, descarga el `keel-build.json` y contrasta `service.version` y `specDigest`
contra el diseño del índice. Reporta `verificada` / `desactualizada` / `no verificable` (sin
`stamp`) y sale 1 si alguna está desactualizada. Todo lo de red entra por parámetro (`fetchImpl`),
como el resto de `registry-source.js`.

### Qué se deja explícitamente fuera

- **Descargar código**: `keel new --from registry:<slug>` no cambia. Deriva el diseño; el repo de la
  implementación se clona a mano si el consumidor quiere.
- **Entrada en `derivatives.js`** para que `keel describe` marque el proyecto generado como
  `fresh`/`stale` (el pendiente que reconoce `README.md:150`). El sello es exactamente lo que lo
  habilita, pero es una decisión aparte y no se pide aquí.

## Archivos

**keel-core**
- `src/lib/spec-digest.js` — **nuevo**. `specDigest(dir)`.
- `src/index.js` — reexportar `specDigest`.
- `src/lib/design-index.js` — warning de `serviceVersion` desajustado en `buildIndex()` (~`:181-203`,
  junto al resto de comprobaciones del sidecar).
- `src/lib/registry-source.js` — `fetchStamp(url, { fetchImpl })` para `verify`.
- `src/commands/registry.js` — sección "Implementaciones" en `showRegistryDesign()`; nuevo
  `verifyRegistryDesign()`.
- `src/cli.js` — subcomando `registry verify <slug>` (hereda `--source/--refresh/--offline`,
  `cli.js:19-21`).
- `assets/core/schema/design.schema.json` — propiedad `implementations`.
- `assets/core/docs/design-registry.md` — sección «Compartir una implementación» (sidecar, sello,
  `verify`) + fila en la tabla de compatibilidad: un sidecar con `implementations` es inválido para
  una CLI anterior, que lo degrada a `metadata: null` con warning — motivo extra para que el CI del
  registry vaya pineado.
- `assets/core/docs/building-a-generator.md` — el contrato de `keel-build.json` como obligación de
  todo generador.

**keel-spring**
- `src/commands/build.js` — escribir `keel-build.json` con `force: true` junto a los snapshots
  (~`:151-180`), usando `specDigest` de keel-core y `scaffold.stack`.
- `src/scaffold/gradle.js:134-140` — el `.gitignore` generado no debe excluir `keel-build.json`
  (verificar; hoy solo ignora build artifacts, así que probablemente no hay cambio).
- `README.md` — sección de publicación de la implementación.

**Raíz**
- `CLAUDE.md` — filas nuevas en «Dónde se añade cada cosa»: sello de generación y campo de
  implementación del sidecar. Corregir de paso la línea 52, que aún lista
  `assets/generators/spring/golden/` (borrado en `2d1fec1`).

**Tests**
- `keel-core/test/spec-digest.test.js` — **nuevo**: determinismo entre ejecuciones, invariancia a
  CRLF/LF y a BOM, exclusión de `design.yaml`, cambio de digest al tocar una capa o
  `validation-scenarios.md`.
- `keel-core/test/design-index.test.js` — warning por `serviceVersion` desajustado; `implementations`
  llega intacto a `renderIndexJson()`.
- `keel-core/test/registry.test.js` — `show` con y sin implementaciones; `verify` con `fetchImpl`
  inyectado en los tres desenlaces. Sin red, sin HOME real (patrón ya establecido en ese archivo).
- `keel-spring/test/scaffold.test.js` (o `build-stamp.test.js`) — el sello se emite con los campos
  esperados, su `specDigest` coincide con `specDigest(fixture)`, y se reescribe sin `--force`.

## Verificación

```bash
npm test                                        # los dos workspaces
npm test --workspace packages/keel-core
```

End to end, con `npm link` de ambas CLIs:

1. En un workspace de prueba, `keel-spring build specs/<servicio> --defaults` → existe
   `services/<servicio>-spring/keel-build.json` con `specDigest` no vacío.
2. Editar una capa del diseño, subir `service.version`, re-lanzar `build` **sin `--force`** → el
   sello cambia (no queda omitido por regeneración segura).
3. En un registry de prueba: añadir `implementations` al `design.yaml` con el `serviceVersion`
   correcto → `keel index --check` en verde. Ponerlo desfasado → warning y **exit 1**.
4. `keel registry show <slug> --source <índice local>` → aparece la sección "Implementaciones" con el
   enlace, y el aviso en rojo cuando la versión va por detrás.
5. `keel registry verify <slug>` con `stamp` apuntando a un `keel-build.json` servido localmente →
   `verificada`; alterando el digest → `desactualizada` y exit 1; sin `stamp` → `no verificable` y
   exit 0.
6. Regresión del contrato del índice: un `index.json` generado con `implementations` debe seguir
   siendo legible por la ruta de `parseIndex()` sin cambios de `schemaVersion`.
