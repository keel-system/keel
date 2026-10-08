# Las dos defensas del correo, y el motor

Build genera el adaptador y el renderizador enteros porque lo que llevan dentro no aparece en el camino de
menor resistencia de nadie, y su ausencia no rompe ninguna prueba: el correo sale igual, y sale mal.

## 1. El saneado del asunto y de las cabeceras

Un `\r` o un `\n` dentro de una variable interpolada en el asunto cierra la cabecera `Subject:` y abre otra: un
`Bcc:` que nadie puso. Por eso `MailMessage` (`src/domain/mail/mail-message.ts`) los sustituye por espacios **en
el constructor**, no en el adaptador: ningún camino puede construir un mensaje sin pasar por ahí, tampoco uno
que se escriba mañana y no use el adaptador de hoy. Las cabeceras propias, igual: el valor se sanea y el NOMBRE
se valida (uno malformado o reservado es un error de quien compone el mensaje, no un dato que arreglar).

## 2. El escapado HTML, con una tabla cerrada

En la parte HTML cada variable se escribe como TEXTO: `& < > " '` → `&amp; &lt; &gt; &quot; &#39;`. Es el
conjunto que basta para un dato dentro de un elemento o de un atributo entrecomillado, y es **contrato**: un
escenario que afirma el cuerpo afirma exactamente esto, en los dos servidores del diseño. No es el escapado por
defecto de Handlebars (escribe `&#x27;` y escapa además `` ` `` y `=`), y por eso el renderizador
(`src/infrastructure/mail/handlebars-template-renderer.ts`) instala el suyo. En la parte de texto y en el asunto
**no** se escapa: ahí no hay HTML que proteger y el escapado se vería («Pedido &amp;amp; factura»).

## El motor: Handlebars, sin helpers

Con `templating.source: data` el cuerpo de la plantilla lo escribe alguien que puede ser ajeno al equipo. Un
motor que evalúa expresiones —o que puede llamar a código— es una ejecución remota esperando a suceder.
Handlebars solo sustituye, recorre y condiciona, y no deja acceder al prototipo de los objetos. Por eso:

- **No registres helpers ni partials.** Cada uno es superficie que quien escribe la plantilla puede alcanzar.
- **No lo cambies** por un motor con lógica.
- Las variables llegan **ya formateadas** (un importe tiene reglas de locale que se prueban mejor en el llamante).

Y un detalle que el renderizador ya resuelve: un marcador simple (`{{ nombre }}`) se compila como
`{{this.[nombre]}}`. Sin eso, una variable llamada `if`, `each`, `log`, `this` o `lookup` compite con el motor
—falla, sale vacía o vuelca el mapa entero de variables en el correo—.

## Lo que no hay que tocar

- `SmtpMailSender`: el remitente de respaldo, el Reply-To, los tres plazos y el envío parcial.
- `HandlebarsTemplateRenderer`: el escapado, los marcadores literales, `compile()` (que compila de verdad: el
  `compile` de Handlebars es perezoso y solo fallaría al renderizar) y la caché acotada a 500 compilaciones.
