# Publicar en npm

Guía para publicar los paquetes del monorepo en el registro público de npm:

| Paquete | Carpeta | Bin | Depende de |
|---|---|---|---|
| `@keel-system/keel-core` | `packages/keel-core` | `keel` | — |
| `@keel-system/keel-spring` | `packages/keel-spring` | `keel-spring` | `@keel-system/keel-core` |
| `@keel-system/keel-nest` | `packages/keel-nest` | `keel-nest` | `@keel-system/keel-core` |
| `@keel-system/keel-dotnet` | `packages/keel-dotnet` | `keel-dotnet` | `@keel-system/keel-core` |
| `@keel-system/keel-recover` | `packages/keel-recover` | `keel-recover` | `@keel-system/keel-core` |

En el resto de esta guía se nombran por su carpeta (`keel-core`, `keel-spring`…); el nombre en npm siempre lleva el scope. Todos se instalan igual: `npm i -g @keel-system/keel-<x>`.

La raíz (`keel-monorepo`) es `private: true` y **no se publica nunca**.

Como no hay build, lo que se publica es el código fuente tal cual: `src/` y `assets/` en todos, más `vendor/` (el wrapper de Gradle) en `keel-spring`. Lo decide el campo `files` de cada `package.json`; `test/`, `scripts/` y los `*-check.json` se quedan fuera.

Todos llevan el scope `@keel-system/`. Un paquete con scope se publica **privado** por defecto; por eso el `package.json` de cada uno lleva `"publishConfig": { "access": "public" }`. No quitarlo.

## 1. Requisitos (una sola vez)

```bash
npm login                              # cuenta con permisos de publicación sobre los cinco paquetes
npm whoami                             # comprobarlo
npm org ls keel-system                 # que tu usuario sea miembro del scope (basta para publicar uno nuevo)
for p in keel-core keel-spring keel-nest keel-dotnet keel-recover; do npm owner ls @keel-system/$p; done   # 404 hasta su primera publicación
```

Si la cuenta tiene 2FA activado para publicar, cada `npm publish` pedirá el código (o se pasa con `--otp=<código>`).

## 2. Antes de publicar

```bash
git switch main && git pull
git status                 # árbol limpio
npm install
npm test                   # todos los workspaces en verde
```

Las redes opt-in de cada generador (`compile-check` y compañía en keel-spring, `ts-check` en keel-nest, `cs-check` en keel-dotnet, y las redes en vivo de cada uno) no son obligatorias para publicar, pero si la versión toca el código o el bash que genera un generador, conviene pasar al menos la que cubre lo tocado (ver `CLAUDE.md § Comandos de desarrollo`).

Comprobar qué versión hay ya publicada — **una versión publicada no se puede volver a publicar**, ni siquiera tras despublicarla:

```bash
for p in keel-core keel-spring keel-nest keel-dotnet keel-recover; do echo "$p $(npm view @keel-system/$p version)"; done
```

## 3. Subir las versiones

Semver sobre `0.x`: mientras el mayor sea 0, un cambio incompatible sube el **menor** (`0.3.2 → 0.4.0`) y todo lo demás sube el parche (`0.3.2 → 0.3.3`).

```bash
npm version patch --workspace packages/keel-core   --no-git-tag-version
npm version patch --workspace packages/keel-spring --no-git-tag-version
npm version patch --workspace packages/keel-nest   --no-git-tag-version
npm version patch --workspace packages/keel-dotnet --no-git-tag-version
npm version patch --workspace packages/keel-recover --no-git-tag-version
# o minor / una versión explícita: npm version 0.4.0 --workspace ...
```

`--no-git-tag-version` porque en un monorepo la etiqueta la ponemos a mano (paso 7). El comando actualiza también `package-lock.json`.

Solo se sube la versión del paquete que ha cambiado: si solo cambió `keel-nest`, los demás se quedan donde están. Un cambio en `keel-core/gen` (el núcleo neutral) suele afectar a los tres generadores: publicar `keel-core` y comprobar cada generador con el punto siguiente.

### La dependencia generador → `keel-core`: la trampa del workspace

En local, npm workspaces enlaza cada generador con el `keel-core` **de la carpeta**, así que los tests pasan aunque el `keel-core` publicado no tenga lo que el generador usa. Quien instale desde npm recibirá el que diga el rango, no el de tu disco.

Por eso, si un generador usa algo nuevo de `keel-core` (una exportación nueva de `src/index.js` o de `keel-core/gen`, un schema, un cambio de comportamiento):

1. Publicar primero `keel-core` con esa versión.
2. Subir el rango en el `package.json` de **cada** generador afectado (y de `keel-recover`) → `"@keel-system/keel-core": "^<versión nueva>"`.

Y ojo con el `^` en `0.x`: `^0.5.0` significa `>=0.5.0 <0.6.0`. Si `keel-core` pasa a `0.6.0`, ningún generador (ni `keel-recover`) **la recogerá** hasta que se cambie su rango a `^0.6.0`.

### Si cambia la versión del DSL

Si `keel-core` cambia el enum de `properties.keel` en `assets/core/schema/service.schema.json`, en la misma publicación hay que sincronizar en **los tres generadores**:

- `SUPPORTED_DSL` en `src/lib/assets.js` de cada uno,
- el campo `keel.dsl` de su `package.json`,
- su README,
- y el rango de `keel-core` (punto anterior), porque el DSL nuevo solo lo trae el `keel-core` nuevo.

Y la tabla de compatibilidad de `packages/keel-core/README.md`.

## 4. Revisar el contenido del paquete

```bash
npm pack --dry-run --workspace packages/keel-core
npm pack --dry-run --workspace packages/keel-spring
npm pack --dry-run --workspace packages/keel-nest
npm pack --dry-run --workspace packages/keel-dotnet
npm pack --dry-run --workspace packages/keel-recover
```

Revisar la lista: no debe aparecer `test/`, ni temporales, ni nada fuera de `src/`, `assets/`, `vendor/`, `README.md`, `LICENSE` y `package.json`. Referencia actual: ~225 archivos / ~900 kB para `keel-core`, ~210 archivos / ~1,1 MB para `keel-spring`, ~145 archivos / ~560 kB para `keel-nest`, ~150 archivos / ~650 kB para `keel-dotnet` y ~90 archivos / ~190 kB para `keel-recover` (sus `fixtures/` de legacy se quedan fuera); un salto grande es señal de que se ha colado algo.

## 5. Prueba de humo con los tarballs (recomendado)

Instalar exactamente lo que se va a publicar, fuera del repo, **todos los tarballs en el mismo comando** (si no, cada generador resolvería `@keel-system/keel-core` desde el registro y no se probaría la combinación nueva):

```bash
for p in keel-core keel-spring keel-nest keel-dotnet keel-recover; do
  npm pack --workspace packages/$p --pack-destination ../keel-pack
done

mkdir -p ../keel-smoke && cd ../keel-smoke
npm init -y >/dev/null
npm install ../keel-pack/*.tgz
npx keel --version
npx keel-spring --version
npx keel-nest --version
npx keel-dotnet --version
npx keel-recover --version
npx keel init            # siembra un workspace
npx keel list
```

Al terminar, borrar `../keel-pack` y `../keel-smoke`.

## 6. Publicar

Siempre en este orden: **primero `keel-core`, después los generadores y `keel-recover`** (entre ellos, el orden da igual).

```bash
npm publish --workspace packages/keel-core   --dry-run   # ensayo
npm publish --workspace packages/keel-core
npm publish --workspace packages/keel-spring --dry-run
npm publish --workspace packages/keel-spring
npm publish --workspace packages/keel-nest   --dry-run
npm publish --workspace packages/keel-nest
npm publish --workspace packages/keel-dotnet --dry-run
npm publish --workspace packages/keel-dotnet
npm publish --workspace packages/keel-recover --dry-run
npm publish --workspace packages/keel-recover
```

Con 2FA: añadir `--otp=<código>`.

Verificar:

```bash
for p in keel-core keel-spring keel-nest keel-dotnet keel-recover; do echo "$p $(npm view @keel-system/$p version)"; done
npm view @keel-system/keel-spring dependencies   # el rango de @keel-system/keel-core es el esperado (ídem en los demás)
npx -y -p @keel-system/keel-core@latest keel --version
```

## 7. Commit y etiquetas

```bash
git add packages/*/package.json package-lock.json
git commit -m "chore: publica keel-core X.Y.Z, keel-nest A.B.C…"
git tag keel-core@X.Y.Z
git tag keel-spring@A.B.C
git tag keel-nest@A.B.C
git tag keel-dotnet@A.B.C
git tag keel-recover@A.B.C
git push && git push --tags
```

Una etiqueta por paquete publicado, con el formato `<paquete>@<versión>` sin el scope: `keel-nest@<versión>`, no `@keel-system/keel-nest@<versión>`.

## Versiones previas (beta)

Para probar una versión sin que la reciba quien instale `@latest`:

```bash
npm version prerelease --preid=beta --workspace packages/keel-core --no-git-tag-version   # 0.4.1-beta.0
npm publish --workspace packages/keel-core --tag next
```

Se instala con `npm install @keel-system/keel-core@next`. Cuando esté lista, se publica la versión final normal (va a `latest`).

## Los nombres sin scope (`keel-core`, `keel-spring`, `keel-dotnet`)

Hasta la 0.4.1 de `keel-core`, la 0.1.7 de `keel-spring` y la 0.0.2 de `keel-dotnet` se publicaban sin scope. Esos paquetes siguen en el registro y **no se vuelven a publicar**. Tras la primera publicación con scope, se marcan como obsoletos una sola vez para que quien los instale vea a dónde ir:

```bash
npm deprecate keel-core   "Ahora es @keel-system/keel-core: npm i -g @keel-system/keel-core"
npm deprecate keel-spring "Ahora es @keel-system/keel-spring: npm i -g @keel-system/keel-spring"
npm deprecate keel-dotnet "Ahora es @keel-system/keel-dotnet: npm i -g @keel-system/keel-dotnet"
```

Quien los tenga instalados con `-g` debe desinstalarlos antes de instalar los nuevos (`npm rm -g keel-core keel-spring keel-dotnet`): el comando es el mismo (`keel`, `keel-spring`, `keel-dotnet`) y los dos paquetes se pelearían por él.

## Si algo sale mal

- **`E403 … cannot publish over the previously published versions`**: esa versión ya existe. Subir la versión y volver a publicar.
- **`E402 Payment Required`** al publicar cualquiera de ellos: falta `publishConfig.access: public` y npm intenta publicarlo privado. Restaurarlo (o publicar con `--access public`).
- **`E401` / `ENEEDAUTH`**: sesión caducada → `npm login`.
- **Se publicó una versión rota**: no despublicar (npm solo lo permite en las primeras 72 h y bajo condiciones, y el número queda quemado igualmente). Publicar un parche corregido y marcar la rota:
  ```bash
  npm deprecate @keel-system/keel-spring@0.2.0 "Versión defectuosa, usa 0.2.1"
  ```
- **Se publicó un generador antes que el `keel-core` que necesita**: publicar `keel-core` en cuanto se pueda; mientras tanto, quien instale ese generador recibe un `keel-core` sin lo que espera.
