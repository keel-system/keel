# Careo de flujos: cada escenario ejecutado contra el diseño

Procedimiento del agente `keel-flow-review` (paso 5b de `/keel-design`). Lo que busca es **una
sola cosa**: un `Then` que no se deduce del YAML. No revisa la cobertura ni la calidad del
diseño. Esas tienen sus propias puertas, `keel validate` y `/keel-validate`.

## Por qué no basta la auto-revisión

La auto-revisión del autor (`scenario-authoring.md` §5) recorre el documento **por entidad** y
en estático. Sirve para cazar una proyección mal enumerada, pero no ve lo que solo aparece al
**ejecutar**: el estado que un paso deja al siguiente. Ninguna de las dos corridas lo encontró
en diseño; en las dos lo encontró el agente que traducía los `Then` a pruebas. Este
procedimiento es la lectura que hace ese agente, adelantada al diseño.

## La tabla por flujo

Por cada bloque `FL-*`, antes de opinar, escribe (en tu razonamiento, no en la salida):

| Paso | Qué hace según el YAML | Estado resultante (lo relevante) | Aserciones que toca | ¿Se deducen? |
|---|---|---|---|---|
| Given | las operaciones o datos que el Given nombra | filas, estados, campos estampados, eventos ya publicados | — | ¿es alcanzable por la superficie que exige? |
| When 1 | la operación con su input | transición, campos nuevos, `updatedAt`, eventos | Then 1..n | sí / no + por qué |

La columna de estado es la que caza los huecos. Si no la escribes, acabas leyendo el `Then` como
verdadero porque suena bien.

## Lista cerrada de contradicciones (`kind`)

| `kind` | Qué es | Ejemplo medido |
|---|---|---|
| `carried-state` | Un paso anterior cambió algo que el `Then` da por intacto: `updatedAt`, un estado, un contador, una posición | catalog `FL-PRD-050`: «el primero es `p25`» con transiciones después de crear |
| `event-payload` | El `Then` enumera un evento con campos que no casan con su payload en `messaging` (de más, de menos, o presentes cuando el `Given` no los rellena) | catalog `FL-PRD-001`: `ProductCreated` sin `description` |
| `count` | Un número del `Then` (operaciones, elementos, eventos) que el diseño no da | catalog `FL-SEC-001`: 21 operaciones donde hay 19 |
| `evaluation-order` | Con dos guardas que fallan a la vez, el `Then` espera el error que el orden declarado no produce | — |
| `unreachable-given` | El `Given` exige un estado al que ninguna operación o evento declarado lleva, o una identidad que `security` no declara | — |
| `cross-flow` | Dos escenarios afirman cosas incompatibles sobre el mismo estado u operación | — |
| `unobservable` | Una aserción que ninguna prueba de caja negra puede hacer (lo interno, «sin reintentos») | stock-reservation: «ni DLQ ni reintentos» |
| `other` | Nada de lo anterior. Úsalo poco: si se repite entre diseños, es una fila nueva de esta tabla | — |

## Reglas

- **La fuente es el YAML, no la prosa.** Una `rule` en prosa describe el comportamiento, pero
  si contradice un campo estructurado, lo que se reporta es esa contradicción.
- **Lo que valida la entrada y lo que se valida después de normalizar son cosas distintas.** El
  `pattern` de un value type describe el valor YA normalizado: si una `rule` normaliza (a
  mayúsculas, sin espacios…), un valor de entrada que aún no cumple el patrón **no** es un 400
  de formato, llega a la regla. Tratarlo como rechazo en el borde fue el falso positivo de la
  primera medición. Las cotas (`maxLength`, `min`…) y `required` sí se validan en la entrada.
- **No repitas `keel validate`.** Si el hallazgo ya sale con un id `CHK-*` u `OBL-*`, no lo
  anotes.
- **Una aserción que depende de algo que el diseño no fija es un hallazgo**, no una
  suposición tuya. «Nada en el diseño dice X» es una `evidence` válida.
- **Propón en el sitio más barato.** Si el escenario dice algo que el diseño no promete, lo
  normal es corregir el escenario. Si el escenario dice lo que el negocio quiere y el YAML no
  lo recoge, el que cambia es el diseño. La decisión es del diseñador; tú das las dos opciones
  cuando hay dos.

## Después del careo

El diseñador decide cada hallazgo y lo anota en `resolution`:
- `scenario`: se corrigió el escenario;
- `design`: se corrigió el YAML;
- `accepted`: se acepta a sabiendas, con `reason`.

`keel validate` avisa (`CHK-SCEN-FLOW-REVIEW-STALE`) mientras falte el careo, quede algún
hallazgo sin decidir o los escenarios hayan cambiado desde el careo. Si se corrige un
escenario, su sello cambia y **ese flujo se vuelve a carear**: lo corregido también tiene que
deducirse.

## Cuándo se deja de carear

El careo tiene **presupuesto: tres pasadas por versión del diseño** (`passes` en
`flow-review.yaml`), y termina de una de estas dos formas, nunca de otra:

1. **No quedan hallazgos abiertos**: cada uno tiene su `resolution`.
2. **Se agotó el presupuesto**: lo que queda **se decide**, no se recarea. El aviso cambia de id
   (`CHK-SCEN-FLOW-REVIEW-EXHAUSTED`) y lo dice con esas palabras.

El motivo es que el careo no converge solo: cada pasada encuentra algo nuevo —sobre `catalog`
0.1.1, ya corregido, salieron 24 hallazgos—, así que «carear hasta que no salga nada» es un gate
que no termina, y un gate que no termina se aprende a ignorar. Si en la tercera pasada siguen
apareciendo contradicciones de **clases nuevas**, lo que el careo está diciendo no es que falte
otra pasada: es que el diseño no está listo para cerrarse, y eso se habla con el usuario.

**Cada pasada carea solo lo que hace falta.** El alcance lo calcula `keel validate` con el sello
de cada flujo:

| Pasada | Cuándo | Qué carea |
|---|---|---|
| Completa | no hay careo previo, o un hallazgo se cerró con `resolution: design` (cambió el YAML, así que lo careado de los demás flujos salía de un diseño que ya no existe) | todos los `FL-*` |
| Incremental | solo cambió el texto de algunos flujos | esos flujos, más los que tengan un hallazgo `cross-flow`: dicen que dependen de otro flujo, y el otro pudo cambiar |

Subir la versión del diseño devuelve presupuesto, porque es otro diseño y le toca su careo. Es la
misma caducidad que ya gobierna `review.yaml` y `decisions.yaml`.
