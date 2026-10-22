---
name: keel-recover-sandbox
description: "Levanta un servicio legacy en un sandbox de contenedores (pasos 0c-0f de keel-recover): Dockerfile con la cadena de su época, compose con sus dependencias en una red sin salida a internet, bucles de build y de arranque con presupuesto, y el juez `keel-recover verify` en verde. Usar cuando haya que ejecutar un legacy que el humano no tiene instalado, antes de observarlo."
argument-hint: "legacy/<servicio>"
---

# /keel-recover-sandbox — levantar el legacy donde el humano no puede

Tu rol: el operador del sandbox. Construyes el ENTORNO en el que un servicio existente arranca tal como era, para que lo que se grabe después sea comportamiento suyo y no un síntoma del entorno. El juez es determinista (`keel-recover verify`) y tiene la última palabra: no das el paso por cerrado mientras no salga en verde.

## Lo que ya está hecho al empezar

`keel-recover init <repo> --name <servicio>` dejó en `legacy/<servicio>/`:

- `legacy.yaml`: dónde está el repo del legacy. **Es la única entrada**: no hay base de producción, ni documentación fuera del repo, ni los repos de sus vecinos.
- `runtime.yaml` (paso 0a) y `environment.yaml` (paso 0b): la huella del runtime y las dependencias del entorno, con `archivo:línea`. Los escribe la herramienta y no se editan, salvo dos sitios que son tuyos: la imagen de cada `provision` y la lista `adaptations` de `environment.yaml`.
- `sandbox/instrument/`: la instrumentación que la herramienta aporta (por ejemplo `v8-coverage-exit.cjs`).

Léelos enteros antes de escribir nada. Todo lo que pongas en el sandbox tiene que salir de ahí o del repo, y si no sale de ninguno, se pregunta.

## Reglas que no se negocian

1. **El código del legacy no se toca.** Entra en la imagen por `COPY` desde el repo, y nada más. Lo que se adapta es el entorno (imágenes, mirrors, variables, stubs), y cada adaptación va a `environment.yaml#adaptations` con su `what` y su `why`. Modificar el código sería caracterizar otro sistema.
2. **El runtime no sale a internet.** Toda red del compose lleva `internal: true`. El build va aparte (`sandbox/build.sh`), con red solo para resolver dependencias, y **nunca** para buscar información sobre el proyecto.
3. **La versión de cada imagen sale de la evidencia**, por este orden: la CI del repo (`runtime.yaml#services` con `via` de CI), la compatibilidad del driver (`environment.yaml#dependencies[].clients`) y la época de las dependencias (`runtime.yaml#source.build_changed`). **Nunca la última por defecto**: en el inc. 1, con el motor moderno la app arrancaba y mentía (orders daba 500 en toda consulta con `/health` en OK; RealWorld daba 422 a un usuario nuevo). Si no usas la de la CI, la adaptación tiene que nombrar la imagen (`mongo:4.4`) y decir por qué: el juez lo exige.
4. **Cada servicio se publica con el alias que el legacy ya espera** (`environment.yaml#dependencies[].provision.aliases`, el `host` de cada endpoint) y la app escucha en el puerto de `environment.yaml#listen`, **nunca** en el de una plantilla.
5. **Todas las imágenes, fijadas por digest**, salvo la que construye `build.sh`, que se llama `localhost/recover/<servicio>:sandbox`.
6. **Nunca un secreto de producción.** Las variables que falten salen de los valores de desarrollo del propio repo (`.env.example`, perfiles de desarrollo, la configuración de la CI) o son de prueba y lo dicen (`recover-sandbox-secret`).
7. **Lo que no se puede contenerizar es un rechazo con su motivo**, no un apaño: .NET Framework sobre Windows, middleware con licencia (WebLogic, IBM MQ), mainframes, un registro privado sin credenciales en el repo (`runtime.yaml#registries[].private`).

## El flujo

1. **0c. Escribe el sandbox** en `legacy/<servicio>/sandbox/`: `Dockerfile` multi-etapa, `build.sh`, `compose.yaml` y `sandbox.yaml`. Cómo, en `references/sandbox-files.md`.
2. **0d. Bucle de build** con presupuesto: `bash sandbox/build.sh` hasta verde. Fallos conocidos y su arreglo, en `references/loops.md`.
3. **0e. Bucle de arranque** con presupuesto: variables, esquema y datos, hasta que la app responda a las dos sondas del juez. También en `references/loops.md`.
4. **0f. Juez**: `keel-recover verify legacy/<servicio>/sandbox`. Imprime cada criterio con su id y escribe `verify.json`. En verde toma el snapshot de la base, que es el estado de partida de las sondas del paso 1, y deja el sandbox arriba.

Lleva un diario en `sandbox/LOG.md`, una fila por intento: paso, qué probaste, qué pasó y qué adaptación dejó. Es la medida del coste del paso 0.

## Los criterios del juez

| Id | Qué exige |
|---|---|
| `VER-COMPOSE` | la app, la herramienta y la base de `sandbox.yaml` existen en el compose y tienen `container_name` |
| `VER-NET-INTERNAL` | toda red `internal: true`, nada de `network_mode` ni de red por defecto. Si falla (o `VER-COMPOSE`), **el sandbox no se arranca**; los demás estáticos en rojo no impiden arrancarlo, pero el veredicto es rojo |
| `VER-DIGEST` | toda imagen fijada por digest |
| `VER-NO-BUILD` | el compose no construye: solo ejecuta |
| `VER-ENGINE` | cada motor en la versión de la CI, o con una adaptación que lo nombre y lo justifique |
| `VER-UP` | la app responde en `app.base` antes de `startup_seconds` |
| `VER-EGRESS` | desde las redes de la app no se llega a internet |
| `VER-READ`, `VER-WRITE` | las dos sondas responden con un estado de su `expect`: no basta «sin 5xx» |
| `VER-DB-TRACE` | la escritura deja rastro en la base que `sandbox.yaml` nombra (la salud del legacy no cuenta) |
| `VER-COVERAGE` | la cobertura graba código de la app, no solo el de sus dependencias |

## Presupuesto y salida

Cada bucle tiene tope: **6 intentos de build y 6 de arranque**. Si se agota, paras y lo dices: qué intentaste, qué falló la última vez y qué decisión necesitas del humano (una versión que el repo no declara, un registro privado, un valor que solo él conoce). Un bucle sin tope no converge.

Al terminar, informa al humano en una tabla corta: intentos de build y de arranque, cada adaptación con su motivo, el veredicto del juez y la cobertura de la ronda 0. Lo siguiente es el paso 1 (observación).
