# Lo que no se toca, y por qué

Seis defensas viven en el código que generó build. Ninguna falla un escenario feliz si se quita: por eso no se dejan a
nadie. Las pruebas emitidas `PaymentGatewayTests` y `PaymentNoticeEndpointTests` vigilan las que se pueden vigilar sin red.

## La firma del aviso, sobre el texto tal como llegó y en tiempo constante

`PaymentNoticeEndpoint` lee el cuerpo como **texto** (un `StreamReader` sobre la petición), sin pasar por el contrato
del cable, y se lo da al verificador, que calcula el HMAC sobre él. Si se leyera como objeto y se volviera a escribir, la
firma dejaría de casar con avisos legítimos —y la tentación entonces es desactivar la comprobación—. La comparación es
`CryptographicOperations.FixedTimeEquals`: un `==` filtra por tiempo cuántos caracteres coinciden. Y un aviso con el
timestamp fuera de la ventana se rechaza aunque la firma sea buena: es un aviso repetido.

## El aviso no decide el desenlace

`PaymentNotices` solo usa el aviso para saber **de qué cobro** habla, y le pregunta el estado a la pasarela. En alguna
pasarela la firma no cubre el cuerpo; en las demás, consultar hace lo mismo para el aviso, la respuesta síncrona y el
barrido, y vuelve inofensivo un aviso que llega desordenado.

## La clave de idempotencia sale de la referencia de negocio

`<referencia>:<acción>` (`GatewayKeys`, la de keel-core, la misma que mandan los servidores de keel-spring y keel-nest).
Con ella un reintento —del cliente, del broker, nuestro, o por otro servidor del diseño— repite la clave y la pasarela no
cobra dos veces. Pero **no es la guarda permanente**: la pasarela guarda también los errores con su clave y la olvida
pasado un tiempo. La guarda permanente es la `naturalKey` del registro sobre la referencia, y la reconciliación.

## Nada se reintenta a ciegas

`PaymentGatewayHttp` no tiene reintentos, y un 5xx, un corte o un plazo vencido lanza
`PaymentGatewayUnavailableException` —también si la respuesta se corta a medias: el cuerpo se lee dentro del mismo
tratamiento—. La acción queda en su estado en vuelo y la resuelve el barrido preguntando. Reintentar una escritura que
la pasarela pudo haber hecho es cobrar, o devolver, dos veces.

## Tampoco por debajo

`SocketsHttpHandler` reenvía **por su cuenta** una petición cuya conexión reutilizada se corta antes de la respuesta
(medido en los clientes salientes de este generador: una escritura llegaba cuatro veces). Por eso cada petición va en su
propia conexión (`Connection: close`) y el `ConnectCallback` de `PaymentGatewayHttp.DefaultHandler` no deja abrir una
segunda para la misma. No cambies el manejador por uno compartido ni quites esa guarda: el precio es no reutilizar
conexiones, y es el correcto.

## Los decimales de cada moneda son los de la tabla

`MoneyAmounts` convierte con la tabla de unidades menores de keel-core —la del JDK, la que usa el servidor de
keel-spring— y nunca redondea. Lo que diga la cultura de .NET no cuenta: los tres servidores del diseño tienen que
convertir 12.500 IQD a la misma unidad.
