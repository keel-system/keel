# Corrida de control de la lectura acotada (DSL 2.27) — `asset-vault` en keel-spring

| Etiqueta | Valor |
|---|---|
| Diseño | `asset-vault` v1.1.3 (DSL 2.27, documental, 9 capas), con `scoping.reads: [getAsset, listAssets]` y `readMiss: forbidden` |
| Stack | `mongodb · rabbitmq · keycloak · redis · minio` (telemetría `none`) |
| Generador | `keel-spring@0.3.0` (`260c908c` al generar) |
| Diseño listo al generar | sí |
| Papel | control |
| Matriz final | **32/32 OK** |
| Huella del agente | 366 archivos registrados por `build`, 0 adoptados, **12 reescritos**, 0 borrados |
| Clasificación de la huella | 11 TODO · 0 consulta · 1 generador · 0 diseño · 0 puerta |
| Huecos del diseño | 0 en `design-gaps.yaml` (el archivo no existe; el informe declara ninguno) |
| Huecos del generador | 2 (ver § Huecos del generador) |
| Agujeros de la puerta | 0 |

Proyecto en `D:\keel-example\vault-227-spring-mongo-rabbit\services\asset-vault-spring`. Corrida de control del incremento 8
de `PLAN-DSL-227-LECTURA-ACOTADA.md`.

## Lo que medía

- **La carga de la ficha va acotada**: `GetAssetQueryHandler` llama a `assetRepository.loadScoped(query.id(), query.readScope())`,
  y `ListAssetsQueryHandler` al finder con el scope. Era lo que no vigila ningún gate.
- **La fila ajena**: FL-AST-003-D (403 también con la ficha cacheada por un `vault-admin`) y FL-AST-004-B (página vacía y
  total 0), en verde.

## Lo que se contrastó

Sin relanzar `score-scenarios.sh`:

- La matriz, contra los JUnit de `build/test-results/integrationTest`: 42 casos, 0 fallos, 32 `FL-*` distintos en verde.
- La huella, contra una regeneración limpia con el mismo stack y los mismos `specs/`: 11 de los 12 reescritos tenían un
  TODO; el otro es `application.yaml`. El arnés no se tocó.
- Clasificación a mano sobre ese diff, sin el agente de contexto limpio que pide la rúbrica.

## Huecos del generador

1. **`max-part-count`** (`multipartPartCount`, `keel-spring/src/scaffold/config.js`). Se dimensiona exactamente al máximo
   válido (24: 4 campos y 20 etiquetas), así que un cuerpo con `maxItems + 1` etiquetas lo rechaza Tomcat al leerlo: 413
   `FILE_TOO_LARGE` en vez del 400 `VALIDATION_ERROR`. El agente lo subió a 64 en `application.yaml`. La primera puntuación
   salió con código 2 por esto (prueba de apoyo `VAL-UPLOAD-4`). Sin mirar aún en los otros tres generadores.
2. **Comentario falso en `infra/test-credentials.env`** (`keel-core/src/lib/gen/identity-provisioning.js`). Dice que el
   secreto del cliente del recurso acotado es `AUTH_CLIENT_SECRET`. Es verdad salvo cuando `AUTH_SCOPED_RESOURCE` coincide con
   un `serviceClients` declarado, como aquí (`rendering-service`), que tiene `AUTH_CLIENT_SECRET_RENDERING_SERVICE`. El arnés
   lee primero el específico y funciona; a quien lo usa a mano, Keycloak le responde `unauthorized_client`.

## Lo que el informe reporta y no es un defecto

`init-keycloak.sh` no corre en `up.sh`: es a propósito, y el agente de infraestructura lo tiene entre sus pasos.

## designGaps

Ninguno.
