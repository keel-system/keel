# Publicar en npm

Guía para publicar los dos paquetes del monorepo en el registro público de npm:

| Paquete | Carpeta | Bin | Depende de |
|---|---|---|---|
| `keel-core` | `packages/keel-core` | `keel` | — |
| `keel-spring` | `packages/keel-spring` | `keel-spring` | `keel-core` |

La raíz (`keel-monorepo`) es `private: true` y **no se publica nunca**.

Como no hay build, lo que se publica es el código fuente tal cual: `src/` y `assets/` en los dos, más `vendor/` (el wrapper de Gradle) en `keel-spring`. Lo decide el campo `files` de cada `package.json`; `test/`, `scripts/` y los `*-check.json` se quedan fuera.

## 1. Requisitos (una sola vez)

```bash
npm login                  # cuenta con permisos de publicación sobre los dos paquetes
npm whoami                 # comprobarlo
npm owner ls keel-core     # que tu usuario aparezca
npm owner ls keel-spring
```

Si la cuenta tiene 2FA activado para publicar, cada `npm publish` pedirá el código (o se pasa con `--otp=<código>`).

## 2. Antes de publicar

```bash
git switch main && git pull
git status                 # árbol limpio
npm install
npm test                   # los dos workspaces en verde
```

Las redes opt-in (`compile-check`, `broker-check`, `claim-check`, `store-check`, `mapping-check`, `index-check`, `mail-check`, `mongo-check`) no son obligatorias para publicar, pero si la versión toca el Java o el bash que genera `keel-spring`, conviene pasar al menos la que cubre lo tocado (ver `CLAUDE.md § Comandos de desarrollo`).

Comprobar qué versión hay ya publicada — **una versión publicada no se puede volver a publicar**, ni siquiera tras despublicarla:

```bash
npm view keel-core version
npm view keel-spring version
```

## 3. Subir las versiones

Semver sobre `0.x`: mientras el mayor sea 0, un cambio incompatible sube el **menor** (`0.3.2 → 0.4.0`) y todo lo demás sube el parche (`0.3.2 → 0.3.3`).

```bash
npm version patch --workspace packages/keel-core  --no-git-tag-version
npm version patch --workspace packages/keel-spring --no-git-tag-version
# o minor / una versión explícita: npm version 0.4.0 --workspace ...
```

`--no-git-tag-version` porque en un monorepo la etiqueta la ponemos a mano (paso 7). El comando actualiza también `package-lock.json`.

Solo se sube la versión del paquete que ha cambiado: si solo cambió `keel-spring`, `keel-core` se queda donde está.

### La dependencia `keel-spring → keel-core`: la trampa del workspace

En local, npm workspaces enlaza `keel-spring` con el `keel-core` **de la carpeta**, así que los tests pasan aunque el `keel-core` publicado no tenga lo que `keel-spring` usa. Quien instale desde npm recibirá el que diga el rango, no el de tu disco.

Por eso, si `keel-spring` usa algo nuevo de `keel-core` (una exportación nueva de `src/index.js`, un schema, un cambio de comportamiento):

1. Publicar primero `keel-core` con esa versión.
2. Subir el rango en `packages/keel-spring/package.json` → `"keel-core": "^<versión nueva>"`.

Y ojo con el `^` en `0.x`: `^0.3.0` significa `>=0.3.0 <0.4.0`. Si `keel-core` pasa a `0.4.0`, `keel-spring` **no la recogerá** hasta que se cambie el rango a `^0.4.0`.

### Si cambia la versión del DSL

Si `keel-core` cambia el enum de `properties.keel` en `assets/core/schema/service.schema.json`, en la misma publicación hay que sincronizar en `keel-spring`:

- `SUPPORTED_DSL` en `packages/keel-spring/src/lib/assets.js`,
- el campo `keel.dsl` de `packages/keel-spring/package.json`,
- su README,
- y el rango de `keel-core` (punto anterior), porque el DSL nuevo solo lo trae el `keel-core` nuevo.

## 4. Revisar el contenido del paquete

```bash
npm pack --dry-run --workspace packages/keel-core
npm pack --dry-run --workspace packages/keel-spring
```

Revisar la lista: no debe aparecer `test/`, ni temporales, ni nada fuera de `src/`, `assets/`, `vendor/`, `README.md`, `LICENSE` y `package.json`. Referencia actual: ~100 archivos / ~400 kB para `keel-core` y ~175 archivos / ~1 MB para `keel-spring`; un salto grande es señal de que se ha colado algo.

## 5. Prueba de humo con los tarballs (recomendado)

Instalar exactamente lo que se va a publicar, fuera del repo, **los dos tarballs en el mismo comando** (si no, `keel-spring` resolvería `keel-core` desde el registro y no se probaría la pareja nueva):

```bash
npm pack --workspace packages/keel-core --pack-destination ../keel-pack
npm pack --workspace packages/keel-spring --pack-destination ../keel-pack

mkdir -p ../keel-smoke && cd ../keel-smoke
npm init -y >/dev/null
npm install ../keel-pack/keel-core-*.tgz ../keel-pack/keel-spring-*.tgz
npx keel --version
npx keel-spring --version
npx keel init            # siembra un workspace
npx keel list
```

Al terminar, borrar `../keel-pack` y `../keel-smoke`.

## 6. Publicar

Siempre en este orden: **primero `keel-core`, después `keel-spring`**.

```bash
npm publish --workspace packages/keel-core  --dry-run   # ensayo
npm publish --workspace packages/keel-core
npm publish --workspace packages/keel-spring --dry-run
npm publish --workspace packages/keel-spring
```

Con 2FA: añadir `--otp=<código>`.

Verificar:

```bash
npm view keel-core version
npm view keel-spring version
npm view keel-spring dependencies     # el rango de keel-core es el esperado
npx -y -p keel-core@latest keel --version
```

## 7. Commit y etiquetas

```bash
git add packages/*/package.json package-lock.json
git commit -m "chore: publica keel-core X.Y.Z y keel-spring A.B.C"
git tag keel-core@X.Y.Z
git tag keel-spring@A.B.C
git push && git push --tags
```

Una etiqueta por paquete publicado, con el formato `<paquete>@<versión>`.

## Versiones previas (beta)

Para probar una versión sin que la reciba quien instale `@latest`:

```bash
npm version prerelease --preid=beta --workspace packages/keel-core --no-git-tag-version   # 0.3.3-beta.0
npm publish --workspace packages/keel-core --tag next
```

Se instala con `npm install keel-core@next`. Cuando esté lista, se publica la versión final normal (va a `latest`).

## Si algo sale mal

- **`E403 … cannot publish over the previously published versions`**: esa versión ya existe. Subir la versión y volver a publicar.
- **`E401` / `ENEEDAUTH`**: sesión caducada → `npm login`.
- **Se publicó una versión rota**: no despublicar (npm solo lo permite en las primeras 72 h y bajo condiciones, y el número queda quemado igualmente). Publicar un parche corregido y marcar la rota:
  ```bash
  npm deprecate keel-spring@0.1.3 "Versión defectuosa, usa 0.1.4"
  ```
- **Se publicó `keel-spring` antes que el `keel-core` que necesita**: publicar `keel-core` en cuanto se pueda; mientras tanto, quien instale `keel-spring` recibe un `keel-core` sin lo que espera.
