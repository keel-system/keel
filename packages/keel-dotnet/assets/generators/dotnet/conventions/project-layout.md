# Stack y estructura del proyecto generado

## Stack

| Pieza | Elección | Por qué |
|---|---|---|
| Plataforma | .NET 10 (LTS), C# 14; `global.json` fija la banda del SDK | un proyecto por capa: la frontera hexagonal la impone el compilador |
| HTTP | ASP.NET Core con **APIs mínimas** y un solo mapa de rutas (`ApiRoutes`) | un único punto de lectura y escritura de JSON (`WireJson`), que es donde se cumple el contrato del cable |
| Persistencia | **EF Core 10** + Npgsql (PostgreSQL), mapeo fluente con nombres explícitos | todo índice y constraint lleva el nombre que fija el diseño |
| Migraciones | `dotnet ef` como herramienta local (`.config/dotnet-tools.json`) | el baseline sale del modelo, no se escribe a mano |
| Pruebas | xUnit v3 (Microsoft.Testing.Platform en `dotnet test`; runner propio en los flujos) | sin licencias comerciales: ni FluentAssertions ni MediatR |
| Paquetes | versión exacta en `Directory.Packages.props`, `packages.lock.json` por proyecto, NuGet Audit | una restauración no cambia nada por sorpresa |

Warnings como errores (`TreatWarningsAsErrors`), nulabilidad activada y analizadores al último nivel: lo que el
compilador avisa no se acumula, y el código lo escribe un agente.

## Comandos

```bash
dotnet restore                     # la primera vez escribe packages.lock.json en cada proyecto: commitéalos
dotnet build                       # la solución entera; un warning es un error (el gate del agente de código)
dotnet test                        # las pruebas que dejó build (perfil test, sin infraestructura)
dotnet tool restore                # dotnet-ef en la versión fijada
bash infra/score-scenarios.sh      # compila + humo del arnés + flujos + matriz FL-* (lo ejecuta el orquestador)
bash infra/check-flows.sh          # compila SOLO las pruebas de flujo (el gate del agente de pruebas)
dotnet run --project src/<Raíz>.Api   # el servidor a mano, perfil local, puerto 8080
```

Para ejecutar flujos sueltos (el agente relanzado desde la fase 2), con la solución compilada:

```bash
dotnet build && dotnet tests/<Raíz>.IntegrationTests/bin/Debug/net10.0/<Raíz>.IntegrationTests.dll \
  -class "<Raíz>.IntegrationTests.ProductCreationFlow"
```

**La ruta del proyecto, corta.** Windows limita las rutas a 260 caracteres y Roslyn no lo dice: bajo un
directorio muy profundo compila un proyecto sin dejar su DLL (`MSB3030: no se pudo copiar el archivo
obj\…\<Proyecto>.dll`). Si aparece ese error, mueve el proyecto a una ruta más corta.

## Estructura

La de `architecture.md`. Además, fuera de `src/`:

```
<Raíz>.slnx                        # la solución: todos los proyectos
global.json · Directory.Build.props · Directory.Packages.props · .config/dotnet-tools.json
config/
├── application.yaml               # lo común a todos los perfiles
└── parameters/<perfil>/*.yaml     # un fragmento por tema y perfil: local, develop, production, test
infra/                             # la infraestructura de PRUEBA y sus scripts (ver infra-validation.md)
tests/
├── <Raíz>.UnitTests/              # las pruebas de build: arranque, configuración, cable, API, cableado, modelo de EF
└── <Raíz>.IntegrationTests/
    ├── Support/                   # el arnés: FlowTest, FlowServer, FailureCapture, JsonShape, ScenarioOrder
    ├── HarnessSmoke.cs            # el humo del arnés
    └── <Flujo>Flow.cs             # UNA por flujo FL-*, las escribe el agente de pruebas
specs/                             # snapshot del diseño (no se edita aquí)
docs/                              # contratos derivados del diseño (openapi), y docs/keel/ (estas guías)
```

## Configuración por perfiles

El perfil activo sale de `PROFILE` (default `local`; varios separados por coma). Cada valor sigue el gradiente
literal (`local`, `test`) → `${VAR:default}` (`develop`) → `${VAR}` sin default (`production`): una variable
obligatoria sin valor **impide arrancar**, nombrándolas todas. La configuración se carga y se valida antes de
crear la aplicación (`ServiceConfiguration.Load()` en `Program.cs`) y llega a quien la necesite como
`ServiceConfiguration` inyectada (`configuration.Get("clave.anidada")`).

Un valor operativo nuevo (un tope, un plazo, un umbral) va en un fragmento de `config/parameters/<perfil>/` **en
los tres perfiles de despliegue**, nunca como literal en el código ni leyendo `Environment` a pelo. Los perfiles:

| Perfil | Base de datos | Esquema |
|---|---|---|
| `local` | la de `infra/` (literal) | lo crea EF Core desde el modelo (`EnsureCreated`, sobre una base vacía) |
| `develop` | `${DB_URL:...}` | las migraciones de EF Core, aplicadas al arrancar |
| `production` | `${DB_URL}` obligatoria | las migraciones |
| `test` | ninguna (`database.enabled: false`) | — |

La URL de la base admite la JDBC de keel-spring tal cual (`jdbc:postgresql://host:puerto/base`): el mismo `.env`
sirve para los tres servidores del diseño.

## Qué genera build y qué completa el agente

| Pieza | Build | Agente |
|---|---|---|
| Dominio: value objects con guardas, enums, errores, eventos, `<Tipo>Format` | entero | — |
| Agregados: estado, rehidratación, `TransitionTo`, propiedades | entero | factory `Create`, métodos semánticos, guardas de invariante |
| Puertos de repositorio | la firma derivable (`FindById`, finder de la clave natural, `List`, `Save`, `DeleteById`) | lo que pidan las `preconditions`/`rules` (un `ExistsBy…`, un contador) — en el puerto **y** en su adaptador |
| Mensajes, DTOs, mappers | enteros (un campo que no sabe derivar sale como `Todo.Value<T>(...)`) | completar los `Todo.Value` |
| Handlers | firma, dependencias y notas del diseño, terminando en `throw new NotImplementedException("TODO: …")` | la lógica |
| Registro de handlers (`UseCaseRegistration`) | entero | — (una dependencia nueva de un handler se registra sola si es un puerto o un mapper ya registrado) |
| API REST, errores, paginación | entera | — |
| Persistencia: filas, mapeo fluente, adaptadores, transacción, traducción de constraints | entera | ampliar el adaptador cuando se amplía el puerto |
| Baseline de migraciones | el mecanismo (`infra/export-schema.sh`, `infra/verify-baseline.sh`, `dotnet ef`) | el pase de calidad lo crea, revisa y verifica |
| Pruebas de flujo | el arnés y el humo | una por flujo |

## Reglas de la estructura

- Un archivo por tipo, con el nombre del tipo (`CreateProductCommandHandler.cs`). El namespace sigue a la carpeta.
- Lo que build genera no se mueve de sitio: los `using` de los demás archivos generados dependen de él.
- Nada en `src/` lee variables de entorno salvo la carga de configuración.
- Lo que build marca como **de build** (endpoints, lectores, middleware, adaptadores generados, arnés) no se
  reescribe para «mejorarlo»: el siguiente `keel-dotnet build --refresh` lo pondría al día y el cambio se perdería,
  o peor, chocaría.
