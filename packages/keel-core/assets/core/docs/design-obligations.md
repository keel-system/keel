# Obligaciones de diseño

Las decisiones que un diseño **abre** al declarar algo, y que nadie echa de menos si no se
cierran. Cada una tiene un **id estable**, y ese id es lo único que hace que una decisión sin
tomar se pueda aceptar por escrito, contar en el catálogo y seguir entre corridas.

## Por qué existe esta lista

El método ya tenía el modelo entero: las 17 clases del análisis de huecos, con su disparador,
su severidad y su forma de cierre. Lo que no tenía era **dónde escribir el resultado**. El
análisis se hacía en la conversación, el registro de decisiones estructurales también, y la
clase 16 admite el problema de frente: con el contexto compactado o el diseño heredado, ese
registro desaparece y toda entrada aplicable vuelve a ser un hueco.

En paralelo, `keel validate` ya detectaba decenas de estas decisiones. Las imprimía como avisos
y acto seguido escribía `✔ Servicio válido`. Un aviso que no bloquea, que no se registra y que
nadie está obligado a contestar es indistinguible de no haberlo emitido: lo que las corridas de
`info/` documentan es el mismo hueco reportado como `designGap` cuatro veces seguidas, ya con
un agente escribiendo Java y con `build --force` como única salida.

Una obligación es ese aviso con id. La regla es:

- **Se cierra en el diseño** declarando lo que faltaba. No necesita entrada en ningún sitio.
- **O se acepta por escrito** en `decisions.yaml`, con su motivo y la versión en que se tomó.
  Aceptarla no la esconde: `keel validate` la sigue listando.
- **Lo que no vale es dejarla sin contestar**, y por eso bloquea.

Hay obligaciones que **no admiten aceptación**: aquellas en las que no existe un default seguro,
donde «aceptado» significaría dejársela al generador. Están marcadas como tal en la tabla.

## La tabla

| id | Qué lo enciende | Decisión que abre | Clase | Aceptable |
|---|---|---|---|---|
| `OBL-IDEM-RACE-CODE` | `use-cases`: alguna operación declara `idempotency` | la carrera de la clave no tiene `code` nombrado | 4 | sí |
| `OBL-IDEM-REUSE-CODE` | `use-cases`: alguna operación declara `idempotency` | el desenlace «misma clave, otro cuerpo» no tiene `code` nombrado | 4 | sí |
| `OBL-CONCURRENCY-CODE` | `persistence`: `consistency.optimisticLocking` es `all` o `declared` | el conflicto de escritura concurrente no tiene `code` nombrado | 4 | sí |
| `OBL-ENTITY-UNREACHABLE` | `domain`: una raíz de agregado a la que ninguna operación se refiere | una raíz de agregado que ninguna operación puede crear | 14 | sí |
| `OBL-RESOURCE-SCOPE` | `use-cases`: una operación protegida por rol declara un error 403 | un 403 que nada de lo declarado puede producir | 9 | no |

La columna **Clase** es la del análisis de huecos (`gap-analysis.md`), para que el barrido del
agente y la validación mecánica hablen del mismo hueco con el mismo nombre.

## Cómo se cierran

`OBL-RESOURCE-SCOPE` va aparte porque es la única que **no admite aceptación**. Se cierra
declarando `authentication.scoping` —de dónde sale la acotación por recurso: el claim del
token, qué identifica al recurso, qué error rechaza y qué roles quedan exentos— o retirando
ese 403 si el permiso no se acota por recurso. Aceptarla significaría que el generador decide
quién alcanza qué, y lo que decide por omisión es que todo el mundo alcanza todo.

Las otras tres se cierran igual entre sí, porque son la misma decisión sobre tres mecanismos: el
conflicto que enciende el mecanismo llega al cliente con un `code`, y el diseño puede nombrarlo
o dejar que se use el canónico de `framework-errors.md`. Nombrarlo es declarar en `errors` un
`code` de la familia del canónico, con su mismo status. Aceptarlo es decir por escrito que el
canónico es el contrato público de este servicio.

Lo que no es opción es ignorarlo: el `code` sale por la API de todas formas, lo ven los
integradores y lo afirman los escenarios.

## `decisions.yaml`

Vive junto a las capas, en `specs/<servicio>/`. No forma parte del DSL: no describe lo que el
servicio hace, sino qué se decidió no declarar y por qué.

```yaml
decisions:
  - id: OBL-IDEM-REUSE-CODE
    scope: use-cases
    reason: >
      El único cliente es nuestro BFF, que nunca reutiliza una clave con otro cuerpo.
      Se acepta IDEMPOTENCY_KEY_REUSED como contrato público del servicio.
    since: 1.4.0

coverage:
  - gapClass: 4
    units: [createOrder, cancelOrder]
    result: findings
```

- `scope` es el que la obligación nombra al levantarse. Una decisión sobre un `scope` que el
  diseño ya no levanta se reporta como **huérfana**: describe un hueco que no existe.
- `reason` es lo único que distingue una decisión de un olvido. Una frase que no dice nada no
  vale de nada.
- `since` es el `service.version` en que se tomó. Cuando el diseño cambia de **minor o de
  major** la aceptación **caduca** y hay que reafirmarla: la asunción que la sostenía puede
  haber dejado de ser cierta. Un patch no la caduca — reafirmar por cada errata corregida
  enseña a subir el número sin leer, que es el hábito que este archivo existe para romper.
- `coverage` responde a la exigencia del análisis de huecos: sin la tabla, una clase que se
  recorrió y salió limpia es indistinguible de una que nadie miró.

## Añadir una obligación

1. Fila en `src/lib/obligations.js`, con su `gapClass`, su `kind` y su `waivable`.
2. Fila en la tabla de este documento. `test/obligations.test.js` ata las dos: una obligación
   que el generador levanta y el documento no explica manda a cerrar algo que nadie sabe qué es.
3. El emisor. Para `kind: decision` es `crossrefs.js`, que la levanta con el helper `obligation(...)`
   — nunca con un literal, porque el helper es lo que garantiza que el id exista.

Un `kind: review` no tiene emisor mecánico a propósito: es lo que solo un lector puede juzgar, y
su fila existe para que `/keel-validate` la recorra y dé veredicto por id.
