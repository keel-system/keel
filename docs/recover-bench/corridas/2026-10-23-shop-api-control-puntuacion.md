# Corrida de control de shop-api: puntuación contra la hoja

Puntuada el 2026-10-23 contra `shop-api.answers.yaml`. El `FIDELITY.md` se guardó antes de abrir la hoja
(`2026-10-23-shop-api-control-FIDELITY.md`), y el informe del orquestador está en `2026-10-23-shop-api-control-diseno.md`.
El alcance es el de la corrida: de sandbox a diseño cerrado (`--ready` 13/13), sin generación ni paridad.

Solo cuentan las filas `measured`: 68 antes de la corrida y 70 después. La corrida añadió dos filas con
`found_by: tool`, SA-DEF-11 y SA-DEF-12. Las filas `read` y la refutada (SA-ERR-06) no puntúan.

## Fidelidad

| Categoría | Encontrados | Fallos |
|---|---|---|
| environment | 6 / 9 | SA-ENV-03, SA-ENV-05, SA-ENV-07 |
| asset | 3 / 3 | — |
| surface | 3 / 3 | — (pero `surface.yaml` salió sin rutas: ver abajo) |
| model | 11 / 11 | — |
| rule | 10 / 11 | SA-RULE-11 |
| error | 7 / 7 | — |
| security | 6 / 7 | SA-SEC-06 (absorbido por `fix-identity-oidc`) |
| effect | 2 / 3 | SA-EFFECT-03 |
| concurrency | 2 / 4 | SA-CONC-02, SA-CONC-04 |
| defect | 11 / 12 | SA-DEF-10 (absorbido por `fix-identity-oidc`) |
| **Total** | **61 / 70 (87 %)**; 59 / 68 sobre la hoja de antes | |

| Métrica | Valor |
|---|---|
| `keep` en verde | 27 / 27 |
| Defectos detectados como `fix` | 11 / 12. Dos de ellos no estaban en la hoja: el precio que decide el cliente en `POST /cart` (SA-DEF-11), el más grave del legacy después de la escalada de rol, y la línea sin descripción que no se guarda (SA-DEF-12) |
| Cobertura | 85,0 % de líneas (JaCoCo), en una sola ronda |
| Procedencia | 95 measured, 18 read, 69 asked, **0 inferred** |
| Contaminación (canarios) | **0**: ni estado de pago, ni openid, ni `@ControllerAdvice` |
| Activos aprovechados | 3 / 3: el seed, `test.http` traducido a la ronda 0 sin grabar su petición errónea, y `customer2` usado solo como dueño de pedidos, sin adivinar su contraseña |

## Calibración: ¿se puede creer `FIDELITY.md`?

**Huecos confesados: 0 de 9.** Ningún fallo está en `unobserved.yaml` ni en los rechazos. Por su peligro se dividen así:

| Hecho | Por qué falta | ¿Peligroso? |
|---|---|---|
| SA-CONC-04: dos checkouts a la vez cobran dos pedidos con una sola línea | **Defecto de herramienta.** La clave del desenlace de una sonda repetida solo llevaba los status HTTP, y de los efectos se guardaba la primera repetición, que salió en serie (un pedido de 60 y otro vacío). El diseñador lo leyó como «el segundo pedido sale vacío» (`fix-checkout-empty-cart`, «o dos a la vez»), que es falso. Remedido con la clave nueva: 10/10 son el doble cobro | Sí. El regenerado lo evita de rebote (bloqueo optimista en todo e idempotencia en el checkout), pero ningún escenario lo afirma |
| SA-CONC-02: `finish` y `cancel` a la vez sobre el mismo pedido | Sin sonda | Mitigado por el bloqueo optimista; sin escenario |
| SA-RULE-11: las líneas salen en orden aleatorio | No se repitió ninguna sonda. El diseño fija un orden por id (decisión del cierre) y lo etiqueta `measured`. Los flujos evitan afirmar orden con más de una línea, así que no hay verde engañoso | Para la paridad: el legacy grabó un orden cualquiera |
| SA-EFFECT-03: cada arranque borra y recarga la base | No se leyó `ddl-auto: create` | Para la operación del sandbox, no para el diseño |
| SA-ENV-03: wrapper de Maven roto | **Defecto de herramienta**: `fingerprint` daba `wrapper: true` con solo ver `mvnw` | No: el sandbox usó la imagen de Maven |
| SA-ENV-05: las pruebas no necesitan base | El agente afirmó lo contrario como motivo de `-DskipTests` | Error de precisión, sin consecuencia para el diseño |
| SA-ENV-07: compose con postgres 9.4.5 | El compose está en la raíz del repo, fuera de `backend/`, que es lo que se pasó a `init`. La adaptación dice «el repo no declara versión», y eso es falso a nivel de repo | Bajo |
| SA-SEC-06, SA-DEF-10 | La identidad pasa a OIDC: el hecho deja de existir en el servicio nuevo | No |

**Cobertura frente a recall**: 85 % frente a 87 %, coherentes. Pero los dos fallos de concurrencia no los habría
destapado más cobertura: una carrera se ve en la distribución de los efectos, no en las líneas ejecutadas.

**Errores de precisión** (afirmaciones falsas en lo recuperado):

1. `runtime.yaml` con `build.wrapper: true` (herramienta).
2. `environment.yaml`: «las pruebas necesitan una base viva» (agente).
3. La adaptación de PostgreSQL: «el repo no declara versión» (agente, con el alcance de `init`).
4. `fix-checkout-empty-cart`: «o dos a la vez deja otro pedido vacío» (agente, a partir de una grabación que no podía mostrar la distribución).
5. `provenance.yaml`: el orden de las líneas de `getCart` va como `measured` cuando es una decisión del cierre (agente).

## Arreglos que salen de aquí

| Hallazgo | Arreglo |
|---|---|
| La carrera que solo se ve en la base | `outcomeKey` añade la huella del diff de la base sin las secuencias (`|db=<8 hex>`), y la grabación guarda `outcomeEffects`: un diff por desenlace distinto. Medido sobre el sandbox de la corrida: R0-066 pasa de un desenlace a dos (4/10 y 6/10), los dos con el doble cobro |
| `mvnw` sin `.mvn/wrapper/` | `fingerprint` lo da como `wrapper: false` y lo explica en la evidencia |
| Las rutas de Boot 2 | `spring-log` lee el log a TRACE con su context path (commit 136ccb3) |
| Declaraciones en la raíz del repo cuando el legacy es un subdirectorio | **Pendiente**: que `fingerprint` y `env-deps` lean también el CI y el compose de la raíz de git, marcados como del repo |
| El orden aleatorio de una colección | **Pendiente**: repetir cada sonda una vez y avisar de las colecciones que solo cambian de orden (el operador lo midió así: 3 de 10 sondas) |
