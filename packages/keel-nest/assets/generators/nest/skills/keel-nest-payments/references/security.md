# Lo que no se toca, y por qué

Cinco defensas viven en el código que generó build. Ninguna falla un escenario feliz si se quita: por eso no se
dejan a nadie.

## La firma del aviso, sobre el texto tal como llegó y en tiempo constante

El lector JSON del contrato del cable (`src/infrastructure/http/http-platform.ts`) deja pasar el cuerpo de
`/webhooks/payments` **sin leerlo**, y `PaymentNoticeController` se lo da como texto al verificador, que calcula el
HMAC sobre él. Si se leyera como objeto y se volviera a escribir, la firma dejaría de casar con avisos legítimos —y
la tentación entonces es desactivar la comprobación—. La comparación es `timingSafeEqual`: un `===` filtra por
tiempo cuántos caracteres coinciden. Y un aviso con el timestamp fuera de la ventana se rechaza aunque la firma sea
buena: es un aviso repetido.

## El aviso no decide el desenlace

`PaymentNotices` solo usa el aviso para saber **de qué cobro** habla, y le pregunta el estado a la pasarela. En
alguna pasarela la firma no cubre el cuerpo; en las demás, consultar hace lo mismo para el aviso, la respuesta
síncrona y el barrido, y vuelve inofensivo un aviso que llega desordenado.

## La clave de idempotencia sale de la referencia de negocio

`<referencia>:<acción>` (la de keel-core, la misma que manda el servidor de keel-spring). Con ella un reintento
—del cliente, del broker, nuestro, o por el otro servidor del diseño— repite la clave y la pasarela no cobra dos
veces. Pero **no es la guarda permanente**: la pasarela guarda también los errores con su clave y la olvida pasado
un tiempo. La guarda permanente es la `naturalKey` del registro sobre la referencia, y la reconciliación.

## Nada se reintenta a ciegas

`PaymentGatewayHttp` no tiene reintentos, y un 5xx, un corte o un plazo vencido lanza
`PaymentGatewayUnavailableException` —también si la respuesta se corta a medias: el cuerpo se lee dentro del mismo
tratamiento—. La acción queda en su estado en vuelo y la resuelve el barrido preguntando. Reintentar una escritura
que la pasarela pudo haber hecho es cobrar, o devolver, dos veces.

## Los decimales de cada moneda son los de la tabla

`MoneyAmounts` convierte con la tabla de unidades menores de keel-core —la del JDK, la que usa el servidor de
keel-spring— y nunca redondea. `Intl` (CLDR) no dice lo mismo en 25 monedas: con él, 12.500 IQD saldrían hacia la
pasarela como 13.
