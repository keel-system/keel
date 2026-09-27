# ticket-desk — Escenarios de validación

> Escenarios del diseño BASE del corpus de mutaciones. Existen para que las comprobaciones
> `CHK-SCEN-*` tengan sujeto: cada una cruza el diseño contra este documento, y sobre él
> tienen que estar todas en silencio. Todos los flujos se ejecutan con un token del
> rol `agent`.

## Matriz de cobertura

| Operación | Flujos | Superficie |
|-----------|--------|------------|
| createTicket | FL-TCK-001, FL-TCK-001-B | usuarios |
| getTicket | FL-TCK-002, FL-TCK-002-B | usuarios |
| listTickets | FL-TCK-003 | usuarios |
| closeTicket | FL-TCK-004 | usuarios |
| archiveQueue | FL-QUE-001 | usuarios |
| noteEscalation | FL-ESC-001, FL-ESC-001-B | suscripción (interna) |

## Flujos

### FL-TCK-001: alta de un ticket

**Given** un solicitante sin bloqueo.
**When** se llama a `createTicket` con un asunto de 20 caracteres.
**Then** responde 201 y el ticket nace en `open`.

#### FL-TCK-001-B: solicitante bloqueado

**Given** un solicitante con el alta bloqueada.
**When** se llama a `createTicket`.
**Then** responde 422 con `REQUESTER_BLOCKED`.

### FL-TCK-002: consulta con perfil

**Given** un ticket existente y el directorio contestando.
**When** se llama a `getTicket`.
**Then** responde 200 con el ticket.

#### FL-TCK-002-B: consultas que fallan

**Given** un id que no existe, y después el directorio sin contestar.
**When** se llama a `getTicket` en cada caso.
**Then** responde 404 con `TICKET_NOT_FOUND` y, con el directorio caído, 503 con `DIRECTORY_UNAVAILABLE`.

### FL-TCK-003: listado por asunto

**Given** tres tickets con asuntos distintos.
**When** se llama a `listTickets`.
**Then** llegan ordenados por asunto.

### FL-TCK-004: cierre

**Given** un ticket en `open`.
**When** se llama a `closeTicket`.
**Then** responde 200, el ticket queda en `closed`, se publica `TicketClosed` y sale un correo al solicitante.

### FL-QUE-001: archivo de una cola

**Given** una cola en `active`, y un id de cola que no existe.
**When** se llama a `archiveQueue` con cada uno.
**Then** la primera queda en `archived` (204) y la segunda responde 404 con `QUEUE_NOT_FOUND`.

### FL-ESC-001: escalada anotada

**Given** un ticket existente.
**When** llega `TicketEscalated` con nivel 2.
**Then** la consulta del ticket devuelve el nivel de escalada anotado.

#### FL-ESC-001-B: reentrega de la escalada

**Given** el mensaje del flujo anterior ya procesado.
**When** se reentrega el mismo mensaje.
**Then** no hay segundo efecto: el nivel de escalada no cambia.
