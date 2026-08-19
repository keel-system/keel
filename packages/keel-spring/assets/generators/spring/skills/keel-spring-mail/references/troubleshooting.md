# Cuando un escenario de correo falla

La pregunta útil no es «¿por qué no llega el correo?» sino **de qué lado está el
fallo**: del servidor, del arnés, o de la infraestructura. Estas son las señales que
los separan.

## El buzón no responde

```
No se pudo hablar con el buzón de prueba en http://localhost:8025/api/v1
```

Es infraestructura, no código. `bash infra/validate-infra.sh` lo confirma en un
segundo. Si el resto de servicios están arriba y este no, mira si algo tuyo ya
escucha en 8025 o en 1025.

## `Se esperaban 1 correo(s) para … y llegaron 0 en 15 s`

Cuatro causas, en el orden en que conviene descartarlas:

1. **El handler no llama a `mailSender.send(...)`.** Es la más frecuente y la más
   fácil de comprobar: busca la llamada en el handler de la operación que
   `mail.sentBy` declara. El camino de menor resistencia al implementar una
   operación es no mandar el correo, porque nada del código lo exige.
2. **El envío va dentro de una transacción que hizo rollback.** El correo nunca
   salió porque el `send` no llegó a ejecutarse. Mira el log del servidor: si hay
   una excepción de negocio posterior al punto donde compusiste el mensaje, ahí está.
3. **La dirección no es la que el escenario busca.** `awaitMailTo` filtra por
   destinatario exacto. Un correo que salió a otra dirección no aparece.
4. **El envío falló y el fallo se tragó.** `SmtpMailSender` lanza
   `MailDeliveryException` a propósito; si alguien la capturó y la ignoró en el
   handler, el escenario ve silencio. Busca un `catch` alrededor del `send`.

## El correo llega pero el asunto no es el esperado

Casi siempre es el renderizado, y casi siempre es la **caché**: si `cacheKey` no
distingue dos contenidos, el segundo se renderiza con la plantilla del primero. La
clave tiene que llevar la versión, o lo que sea que identifique el contenido.

Si el asunto sale con un hueco donde iba un dato, la variable no llegó: Handlebars
interpola lo ausente como vacío y no falla. Eso es exactamente lo que la validación
contra las variables **declaradas** existe para impedir — si el diseño la declara
(`templating.declaredVariables: true`) y el correo sale con el hueco, la validación
no se está aplicando.

## Llegan dos correos donde debía llegar uno

La guarda de repetición no está aplicada. Mira cuál declara el diseño para esa
operación:

- `idempotency` → la clave llega por la cabecera `Idempotency-Key` y la sostiene
  `idempotency_record`. Si el segundo correo sale, el `send` está **fuera** del
  tramo que la guarda protege.
- una transición de lifecycle → la repetición la frena el estado del agregado. Si el
  segundo correo sale, el `send` va antes de la transición.

En los dos casos el arreglo es el mismo: el envío va **después** de que la guarda
haya decidido que esta ejecución es la buena.

## `assertNoMailTo` falla: salió un correo que no debía

El rechazo llegó **después** del envío. El orden que el diseño fija (aplicación
activa → plantilla → variables → supresión → persistir → enviar) no es decorativo:
cada comprobación que se salta el orden manda un correo que no se puede retirar.
Reordena el handler; no muevas la aserción.

## El correo sale sin la parte de texto

Con `delivery.parts: [html, text]` el mensaje tiene que ser
`multipart/alternative` con las dos. `MimeMessageHelper#setText(text, html)` lo hace,
en ese orden (la parte preferida va la última). Si solo hay HTML, revisa que estés
pasando los dos argumentos y no la sobrecarga de uno.

No es cosmética: los filtros antispam desconfían de un HTML sin alternativa textual,
y eso no falla en ninguna prueba — se ve en la carpeta de spam de quien lo recibe.

## Falla solo a veces

Es una carrera, y casi siempre la misma: el `Then` lee el buzón sin esperar. Después
del 2xx el correo todavía no ha salido — eso es lo que significa aceptar el encargo
en vez de cumplirlo. Usa `awaitMailTo(...)`, nunca `mailCount(...)` a secas como
primera lectura.

`mailCount` solo vale **después** de haber esperado al correo que sí debe llegar: es
para afirmar que no hay un segundo, no para afirmar que hay un primero.
