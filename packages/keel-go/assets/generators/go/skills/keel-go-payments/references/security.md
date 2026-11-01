# Lo que no se toca, y por qué

Seis defensas viven en el código que generó build. Ninguna falla un escenario feliz si se quita: por eso no se dejan a
nadie. Las pruebas emitidas `internal/infrastructure/payment/<pasarela>_test.go` vigilan las que se pueden vigilar sin
red.

## La firma del aviso, sobre el texto tal como llegó y en tiempo constante

`internal/httpapi/payment_notice.go` lee el cuerpo como **texto**, sin pasar por el contrato del cable, y se lo da al
verificador, que calcula el HMAC sobre él. Si se leyera como objeto y se volviera a escribir, la firma dejaría de casar
con avisos legítimos —y la tentación entonces es desactivar la comprobación—. La comparación es `hmac.Equal`: un `==`
filtra por tiempo cuántos caracteres coinciden. Y un aviso con el timestamp fuera de la ventana se rechaza aunque la
firma sea buena: es un aviso repetido.

## El aviso no decide el desenlace

`application.PaymentNotices` solo usa el aviso para saber **de qué cobro** habla, y le pregunta el estado a la pasarela.
En alguna pasarela la firma no cubre el cuerpo; en las demás, consultar hace lo mismo para el aviso, la respuesta
síncrona y el barrido, y vuelve inofensivo un aviso que llega desordenado.

## La clave de idempotencia sale de la referencia de negocio

`<referencia>:<acción>` (`keys.go`, la de keel-core, la misma que mandan los servidores de los otros tres
generadores). Con ella un reintento —del cliente, del broker, nuestro, o por otro servidor del diseño— repite la clave y
la pasarela no cobra dos veces. Pero **no es la guarda permanente**: la pasarela guarda también los errores con su
clave y la olvida pasado un tiempo. La guarda permanente es la `naturalKey` del registro sobre la referencia, y la
reconciliación.

## Nada se reintenta a ciegas

El cliente de `http.go` no tiene reintentos, y un 5xx, un corte o un plazo vencido devuelve un
`*domain.PaymentGatewayUnavailableError` —también si la respuesta se corta a medias: el cuerpo se lee dentro del mismo
tratamiento—. La acción queda en su estado en vuelo y la resuelve el barrido preguntando. Reintentar una escritura que
la pasarela pudo haber hecho es cobrar, o devolver, dos veces.

## Tampoco por debajo

net/http **reenvía por su cuenta** una petición idempotente —y una con `Idempotency-Key` lo es para él— cuya conexión
reutilizada se corta antes de la respuesta. Por eso el transporte de `http.go` va con `DisableKeepAlives`: cada
petición en su propia conexión. No lo cambies por un `http.DefaultClient` ni por un transporte compartido: el precio es
no reutilizar conexiones, y es el correcto.

## Los decimales de cada moneda son los de la tabla

`money.go` convierte con la tabla de unidades menores de keel-core —la del JDK, la que usa el servidor de keel-spring— y
nunca redondea: un importe con más decimales de los que admite la moneda no se manda. Los cuatro servidores del diseño
tienen que convertir 12.500 IQD a la misma unidad, y un importe se compara con `Cmp`, no con `Equal`, que mira la escala.
