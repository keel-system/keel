# Las dos defensas del correo, y por qué el motor es el que es

Este archivo explica código que **ya está escrito** y que no debes cambiar. Se
documenta porque las tres decisiones de abajo son invisibles: quitarlas no rompe
ninguna prueba, ningún escenario se pone rojo, y el correo sigue saliendo.

---

## 1. El asunto se sanea, y se sanea en el constructor

```java
subject = value.replaceAll("[\r\n]", " ").trim();
```

Está en el constructor de `MailMessage`, no en el adaptador. La razón de que esté
ahí y no en el sitio obvio: así **ningún** camino puede construir un mensaje con el
asunto sin sanear, ni siquiera uno que se escriba dentro de seis meses y no pase por
el adaptador de hoy.

**Qué previene.** El asunto viaja como una cabecera SMTP (`Subject: …`). Un `\r\n`
dentro de una variable interpolada cierra esa cabecera y abre otra:

```
Subject: Tu pedido A-1042
Bcc: atacante@ejemplo.com
 está confirmado
```

Quien controle una variable que acaba en el asunto —el nombre de un cliente, un
número de pedido que viene de fuera— puede añadir destinatarios ocultos a un correo
que sale desde tu remitente verificado.

**Por qué es fácil perderla.** Nada la echa de menos. El asunto se ve bien en
Mailpit, los escenarios pasan, y el fallo solo existe cuando alguien manda la
variable con el salto de línea dentro.

---

## 2. Las variables se escapan como HTML

Handlebars escapa por defecto con `{{variable}}`, y **no se le añaden helpers ni se
usa `{{{variable}}}`** (triple llave = sin escapar).

**Qué previene.** Un `orderNumber` que llega con `<script>` se escribe como texto,
no como marcado. El XSS en correo no es teórico: hay clientes que ejecutan.

**Cuándo se rompe sin querer.** El día que alguien quiera meter un enlace con
formato dentro de una variable y descubra que las etiquetas salen escapadas. La
salida correcta es que el marcado esté en la **plantilla**, con la variable dentro;
nunca marcado dentro de la variable.

---

## 3. El motor no evalúa expresiones

Con `templating.source: data` el cuerpo de la plantilla es un **dato del servicio**:
lo escribe alguien que puede ser ajeno al equipo, por una API o un back-office.

Lo natural en Spring sería Thymeleaf. **No se usa, y no es preferencia.** Thymeleaf
está pensado para plantillas que escribes tú: evalúa expresiones SpEL, y SpEL puede
invocar métodos arbitrarios. Con plantillas de origen externo, eso es una ejecución
remota de código esperando a suceder — quien pueda registrar una plantilla puede
ejecutar código en tu servidor.

Handlebars solo sustituye variables, recorre listas y evalúa condiciones simples. No
hay forma de llamar a nada. Y el `Handlebars` que build instancia va **sin
resolvers**: el cuerpo llega como cadena y no hay nada que buscar en el classpath ni
en disco, así que un `{{> ../../etc/passwd}}` no es una lectura de fichero.

**Qué se paga.** Expresividad. No hay formateo de importes, ni conversión de fechas,
ni condiciones sobre el estado de un pedido dentro de la plantilla: `total` llega ya
como `"89,90 €"`.

**Y es más una virtud que un defecto.** El formato de un importe tiene reglas de
locale y se prueba mucho mejor en el sistema que manda los datos que dentro de una
cadena de texto guardada en una fila de la base de datos.

**No añadas helpers** que salgan de esa frontera (nada de `StringHelpers` con acceso
a la JVM, nada de resolvers de fichero). Cada helper nuevo es superficie que quien
escribe la plantilla puede alcanzar.

---

## Si de verdad hace falta cambiar algo

Cualquiera de las tres es una decisión de seguridad con consecuencias fuera del
servicio (la reputación del remitente es compartida por todos sus consumidores).
Repórtalo al orquestador como `designGap` con el motivo, y que lo decida quien
diseñó — no lo cambies dentro de un ciclo de corrección.
