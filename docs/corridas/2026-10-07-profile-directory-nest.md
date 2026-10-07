# Corrida `profile-directory` — keel-nest (incremento 8: seguridad)

| Etiqueta | Valor |
|---|---|
| Diseño | `profile-directory` v1.0.0 (DSL 2.19, relacional, 5 capas) |
| Stack | `postgresql · keycloak` |
| Generador | `keel-nest@0.0.1` (con el incremento 8) |
| Diseño listo al generar | sí |
| Matriz final | **13/13 OK** |
| Huella del agente | 138 archivos registrados por `build`, 0 adoptados, **4 reescritos**, 0 borrados |
| Huecos del diseño | 0 (el agente señaló uno que ya estaba aceptado en `gaps.yaml`) |
| Huecos del generador | 1 menor (`todo.ts` sin uso, ver § Arreglos) |
| Convertidos en id | |
| Clasificación de la huella | 4 TODO · 0 consulta · 0 generador · 0 diseño · 0 puerta |
| Agujeros de la puerta | 0 |
| Coste del diseño | careo 1→2→0; barrido 14; revisión 5; 8 aceptadas / 6 cerradas |

La corrida que mide el incremento 8 de `PLAN-KEEL-NEST.md`: la primera de keel-nest con capa `security`, y la
primera de cualquier generador sobre un diseño que entra por la puerta de `--ready` sin
`--accept-unready`. Su gemela de keel-spring es `2026-10-07-profile-directory-spring.md`.

## Cómo terminó

**13/13 a la primera**, sin ciclos de arbitraje. Humo del arnés en verde (incluido SMOKE-5, las
credenciales del proveedor), `npm test` 64 pruebas, `baseline: OK` y `baselineTested: OK` en vivo. Sin
`harnessPatches`, sin `culprit: harness`, sin fixes de `infra/` ni de la configuración: el realm lo sembró
`init-keycloak.sh` y los flujos pidieron sus tokens con `tokenFor`/`tokenAs` del arnés.

## La huella, clasificada

| Reescrito | Clase |
|---|---|
| `get-my-card-query-handler.ts`, `save-my-card-command-handler.ts` | TODO legítimo: buscar por `subject`, crear o reemplazar |
| `contact-card.ts` | TODO legítimo: `create` y `replace` (el reemplazo entero de la regla) |
| `README.md` | TODO legítimo: la guía de despliegue, paso 5 del orquestador |

Ningún archivo de seguridad tocado: el hook, las reglas, el JWT, la identidad y la configuración salieron
de `build` y funcionaron tal cual. Es la huella más baja de las corridas de keel-nest (12 → 7 → 4), y la
misma que la de keel-spring en esta corrida descontando su `SecurityConfig`.

## Arreglos

- **`src/application/support/todo.ts` se emitía sin uso** (lo señaló el informe): el helper se sembraba con
  cualquier mapper aunque ninguno lo importara. Ahora solo si alguno lo usa (`06e648f`).
- El informe anota también un `TODO` en `persistence-errors.ts` («el diseño no declara su error; este code
  es una convención del scaffolding»). El texto es engañoso: `CONTACT_CARD_SUBJECT_ALREADY_EXISTS` es el
  `code` canónico de la familia `uniqueness` de `framework-errors.md`, no una convención. Lo escriben igual
  los dos generadores, y en keel-spring hizo que su agente lo reportara como `designGap`. Reescrito en los
  dos: ahora dice que es el `code` canónico y cómo se sustituye.

## designGaps

(ninguno; ver `natural-key-error-undeclared` en la corrida de keel-spring)
