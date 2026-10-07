# Stack y estructura del proyecto generado

## Stack

| Pieza | Elección | Por qué |
|---|---|---|
| Runtime | Node 22.12+ (`.nvmrc`: 24), **ESM** (`"type": "module"`, imports relativos con `.js`) | NestJS 12 es solo ESM |
| Framework | NestJS 12 sobre **Fastify** (`@nestjs/platform-fastify`) | un único punto de lectura y escritura de JSON, que es donde se cumple el contrato del cable |
| Lenguaje | TypeScript ~6.0 en `strict` | el código lo escribe un agente: lo que el compilador no le exige no lo comprueba nadie |
| Persistencia | TypeORM 1.x sin `@nestjs/typeorm` (un `DataSource` propio) | PostgreSQL (`pg`) o MySQL (`mysql2`), según `keel-stack.json` |
| Pruebas | Vitest 5 | Jest solo carga Nest 12 desde Node 24.9 |
| Frontera hexagonal | dependency-cruiser (`npm run check:architecture`) | en TypeScript un import es una línea que el compilador acepta venga de donde venga |

## Comandos

```bash
npm install                    # la primera vez (crea package-lock.json: commitéalo); después, npm ci
npm run typecheck              # tsc --noEmit sobre src/ y test/
npm run build                  # nest build → dist/ (el gate de compilación del agente de código)
npm run check:architecture     # la frontera hexagonal + la caja negra de los flujos
npm test                       # las pruebas que dejó build (perfil test, sin infraestructura)
npm run test:integration       # los flujos FL-* (necesita infra/ arriba)
bash infra/score-scenarios.sh  # humo del arnés + flujos + matriz FL-* (lo ejecuta el orquestador)
bash infra/check-flows.sh      # compila SOLO las pruebas de flujo (el gate del agente de pruebas)
```

## Estructura

La de `architecture.md`. Además, fuera de `src/`:

```
config/
├── application.yaml               # lo común a todos los perfiles
└── parameters/<perfil>/*.yaml     # un fragmento por tema y perfil: local, develop, production, test
infra/                             # la infraestructura de PRUEBA y sus scripts (ver infra-validation.md)
test/
├── *.test.ts                      # las pruebas de build: arranque, configuración, cable, API
└── integration/
    ├── support/flow.ts            # el arnés: useFlow(), db(), resetState(), eventually()
    ├── harness-smoke.test.ts      # el humo del arnés
    └── <flujo>.test.ts            # UNA por flujo FL-*, las escribe el agente de pruebas
specs/                             # snapshot del diseño (no se edita aquí)
docs/                              # contratos derivados del diseño (openapi, asyncapi), si existen
```

## Configuración por perfiles

El perfil activo sale de `PROFILE` (default `local`; varios separados por coma). Cada valor sigue el
gradiente literal (`local`, `test`) → `${VAR:default}` (`develop`) → `${VAR}` sin default
(`production`): una variable obligatoria sin valor **impide arrancar**, nombrándolas todas. La
configuración se carga y se valida antes de crear la aplicación (`loadConfiguration`) y llega a quien la
necesite como `Configuration` inyectada (`configuration.get('clave.anidada')`).

Un valor operativo nuevo (un tope, un plazo, un umbral) va en un fragmento de
`config/parameters/<perfil>/` **en los tres perfiles de despliegue**, nunca como literal en el código ni
leyendo `process.env` a pelo. Los perfiles:

| Perfil | Base de datos | Esquema |
|---|---|---|
| `local` | la de `infra/` (literal) | lo crea TypeORM (`synchronize`) |
| `develop` | `${DB_URL:...}` | las migraciones de `src/migrations/` (`migrations-run`) |
| `production` | `${DB_URL}` obligatoria | las migraciones |
| `test` | ninguna (`database.enabled: false`) | — |

La URL de la base admite la JDBC de keel-spring tal cual (`jdbc:postgresql://host:puerto/base`): el mismo
`.env` sirve para los dos servidores del diseño.

## Qué genera build y qué completa el agente

| Pieza | Build | Agente |
|---|---|---|
| Dominio: value objects con guardas, enums, errores, eventos, `<Tipo>Format` | entero | — |
| Agregados: estado, rehidratación, `transitionTo`, getters | entero | factory `create`, métodos semánticos, guardas de invariante |
| Puertos de repositorio | la firma derivable (`findById`, finder de la clave natural, `list`, `save`, `deleteById`) | lo que pidan las `preconditions`/`rules` (un `existsBy…`, un contador) — en el puerto **y** en su adaptador |
| Mensajes, DTOs, mappers | enteros (un campo que no sabe derivar sale como `todo(...)`) | completar los `todo(...)` |
| Handlers | firma, dependencias y notas del diseño, terminando en `throw new Error('TODO: …')` | la lógica |
| API REST, filtro de errores, paginación | entera | — |
| Persistencia: entidades, adaptadores, transacción, traducción de constraints | entera | ampliar el adaptador cuando se amplía el puerto |
| Reloj: el disparo de cada operación con `schedule` y las purgas de las tablas del generador | entero | el trabajo del barrido en su handler |
| Baseline de migraciones | el mecanismo (`infra/export-schema.sh`, `infra/verify-baseline.sh`) | el pase de calidad lo exporta, revisa, copia y verifica |
| Pruebas de flujo | el arnés y el humo | una por flujo |

## Reglas de la estructura

- Un archivo por clase, con el nombre en kebab-case (`create-product-command-handler.ts`). Los
  imports relativos llevan `.js`.
- Lo que build genera no se mueve de sitio: los imports de los demás archivos generados dependen de él.
- Nada en `src/` lee `process.env` salvo la carga de configuración.
- Lo que build marca como **de build** (controladores, filtro, adaptadores generados, arnés) no se
  reescribe para «mejorarlo»: el siguiente `keel-nest build --refresh` lo pondría al día y el cambio se
  perdería, o peor, chocaría.
