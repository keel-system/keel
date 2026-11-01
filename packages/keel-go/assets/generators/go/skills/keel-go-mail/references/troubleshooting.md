# Fallos típicos del correo

| Síntoma | Causa habitual | Qué hacer |
|---|---|---|
| `El mensaje no tiene remitente y el diseño no declara uno de respaldo` | el dato del remitente vino vacío y `mail.sender` no tiene `fallback` | es una decisión del diseño: `designGap` |
| `NewMailMessage`: «La cabecera X la compone el propio mensaje» | se pasó una cabecera reservada (From, To, Subject, Content-…) en `Headers` | se pone con su campo de `MailParts`, no como cabecera |
| Dos correos para la misma notificación | la transición a «enviando» se hizo en memoria y no con `ClaimFor…` | la guarda primero: `ClaimFor…(ctx, id)` y, con `found=false`, no se envía |
| El HTML del buzón trae `&apos;` o el texto `&amp;` | se escapó a mano antes de renderizar | se pasan los valores tal cual: el renderizador escapa según la parte |
| `AwaitMailTo` agota la espera | el handler no llama a `Send`, o el barrido que lo empuja no ha pasado | `build/keel-scenarios/server.log` y la cadencia del `schedule` |
| El envío parcial se trata como fallido y se repite | se miró solo el error, no `Partial()` | `errors.As(err, &delivery) && delivery.Partial()`: salió para alguien |
