# Lo que no se toca, y por qué

Cuatro defensas viven en el código que generó build. Ninguna falla un escenario feliz si se
quita: por eso no se dejan a nadie.

## La firma del aviso, sobre el cuerpo crudo y en tiempo constante

`PaymentNoticeController` recibe el cuerpo como `byte[]` y el verificador calcula el HMAC sobre
esos bytes. Si se recibe como objeto y se re-serializa, la firma deja de casar con avisos
legítimos —y la tentación entonces es desactivar la comprobación—. La comparación es
`MessageDigest.isEqual`: un `equals` filtra por tiempo cuántos caracteres coinciden. Y un aviso con
el timestamp fuera de la ventana se rechaza aunque la firma sea buena: es un aviso repetido.

## El aviso no decide el desenlace

`PaymentNotices` solo usa el aviso para saber **de qué cobro** habla, y le pregunta el estado a la
pasarela. En alguna pasarela la firma no cubre el cuerpo; en las demás, consultar hace lo mismo
para el aviso, la respuesta síncrona y el barrido, y vuelve inofensivo un aviso que llega
desordenado.

## La clave de idempotencia sale de la referencia de negocio

`<referencia>:<acción>`. Con ella un reintento —del cliente, del broker, nuestro— repite la clave y
la pasarela no cobra dos veces. Pero **no es la guarda permanente**: la pasarela guarda también los
errores con su clave y la olvida pasado un tiempo. La guarda permanente es la `naturalKey` del
registro sobre la referencia, y la reconciliación.

## Nada se reintenta a ciegas

El cliente HTTP no tiene reintentos, y un 5xx o un timeout lanza
`PaymentGatewayUnavailableException`. La acción queda en su estado en vuelo y la resuelve el barrido
preguntando. Reintentar una escritura que la pasarela pudo haber hecho es cobrar, o devolver, dos
veces.
