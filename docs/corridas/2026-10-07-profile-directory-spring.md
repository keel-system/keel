# Corrida `profile-directory` — keel-spring (gemela del incremento 8 de keel-nest)

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.0.0 (DSL 2.19, relacional, 5 capas) |
| Stack | `postgresql · keycloak` |
| Generador | `keel-spring@0.1.6` |
| Diseño listo al generar | sí |
| Matriz final | **14/14 OK** (13 del documento + `FL-CRD-001-G`, ver § Pruebas) |
| Huella del agente | 173 archivos registrados por `build`, 0 adoptados, **4 reescritos**, 0 borrados |
| Huecos del diseño | 0 (2 en `design-gaps.yaml`, ninguno es hueco: ver § designGaps) |
| Huecos del generador | 1 (el token inválido sin cuerpo, ver § Arreglos) |
| Convertidos en id | |
| Clasificación de la huella | 3 TODO · 0 consulta · 1 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 1→2→0; barrido 14; revisión 5; 8 aceptadas / 6 cerradas |

El mismo diseño y los mismos escenarios que `2026-10-07-profile-directory-nest.md`, generado con
keel-spring para comparar.

## Cómo terminó

Primera puntuación 13 OK · 1 FALLO (FL-CRD-003-C, `culprit: code`), cerrada en un ciclo; después 14/14.
`baselineTested: PENDING`, como siempre en keel-spring.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| `GetMyCardQueryHandler.java`, `SaveMyCardCommandHandler.java`, `ContactCard.java` | TODO legítimo |
| `SecurityConfig.java` | **hueco del generador** (§ Arreglos) |

## Arreglos

### Un bearer que no vale salía como 401 sin cuerpo

`oauth2ResourceServer()` registra su propio `BearerTokenAuthenticationEntryPoint`, y pisaba al
`SecurityErrorHandlers` de `exceptionHandling()`, que solo cubre la petición **sin** token. Con un token mal
formado, caducado o de otra firma, la respuesta era 401 con la cabecera `WWW-Authenticate` y sin
`ErrorResponse`, cuando el contrato pide `code: UNAUTHENTICATED`. FL-CRD-003-C lo cazó y el agente lo
arregló en el `SecurityConfig` generado, avisándolo como defecto del generador.

**Ninguna corrida anterior lo vio porque ningún escenario mandaba un token roto**: todos los 401 eran sin
credencial. keel-nest sí lo cumplía desde el principio: su prueba emitida de la API lo afirma (el bearer
inválido en `/livez`), y es justo la clase de diferencia que la equivalencia existe para cazar.

Arreglo (`06e648f`): cada `oauth2ResourceServer` de cada cadena recibe `authenticationEntryPoint` y
`accessDeniedHandler`. Test en `corrida-fixes.test.js` sobre todas las fixtures con JWT y los dos
proveedores, falsado quitando el arreglo; `compile-check` en verde sobre `profile-directory` y
`asset-vault`. La rama de la cadena de máquinas aparte no la compila ninguna fixture.

## Pruebas

El agente de pruebas convirtió el caso borde de FL-CRD-001-F («`displayName` de exactamente 100
caracteres → `200`») en un escenario con id propio, `FL-CRD-001-G`, que el documento no declara. No falsea
nada —la matriz lo cuenta OK y el documento sigue cubierto entero—, pero es un id inventado: si otro flujo
del documento usara ese id, chocaría.

## designGaps

Los dos que reportó `design-gaps.yaml`, y por qué ninguno es un hueco del diseño:

- `natural-key-error-undeclared` — la unicidad de `ContactCard.subject` sin error declarado. Está decidida:
  `gaps.yaml` (clase 4) acepta el 409 `CONTACT_CARD_SUBJECT_ALREADY_EXISTS`, que es el `code` canónico de
  `framework-errors.md`. Lo provocó el comentario del scaffolding que lo llama «convención» (pendiente en
  los dos generadores); el agente de keel-nest leyó `gaps.yaml` y no lo reportó.
- `domain-length-error` — la cota de `displayName` sin error de dominio. El diseño la declara como
  `maxLength: 100` del input y el escenario fija el 400 `VALIDATION_ERROR` del borde; la guarda del agregado
  es una defensa del agente, no un contrato que falte.
