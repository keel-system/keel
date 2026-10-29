# Arquitectura del servicio

Hexagonal + CQRS, con el mismo reparto de responsabilidades que los servidores de keel-spring, keel-nest y
keel-dotnet del mismo diseño, y **con la granularidad de paquetes de Go**: un paquete es una unidad de
compilación y de API, no una carpeta de clasificación. Lo que en Spring son subpaquetes (`commands/`, `dtos/`,
`mappers/`) aquí son **archivos** del mismo paquete.

```
go.mod / go.sum                # el módulo; go mínimo + toolchain; directiva tool
cmd/server/main.go             # main + run(ctx, args, getenv, stdout) error: el cableado, a la vista
config/                        # application.yaml + parameters/<perfil>/*.yaml, embebidos en el binario
internal/
  domain/                      # agregados, value objects, enums, eventos, errores y puertos
  application/                 # por operación su mensaje y su handler; los DTO, los mapeos y UseCases
  httpapi/                     # el enrutador, los lectores, ErrorResponse y el servidor con sus límites
  infrastructure/<tecnología>/ # un paquete por adaptador: postgres, mysql, mongo, rabbitmq, kafka…
  platform/                    # config, health, y lo transversal que no es de negocio
  architecture/                # la prueba de la frontera hexagonal
```

## Qué puede importar cada paquete

| Paquete | Puede importar |
|---|---|
| `internal/domain` | la biblioteca estándar y su lista blanca |
| `internal/application` | el dominio |
| `internal/httpapi` | la aplicación, el dominio y la plataforma |
| `internal/infrastructure/*` | la aplicación, el dominio y la plataforma |
| `internal/platform/*` | solo la plataforma |
| `cmd/server` | todo: es quien cablea |

`internal/` solo impide que **otro módulo** importe estos paquetes; entre las capas del mismo módulo no protege
nada. Por eso la frontera es una prueba (`internal/architecture/architecture_test.go`) que pregunta a `go list`
qué importa cada paquete y falla si un import la cruza. La prueba se comprueba a sí misma con imports plantados.

## La aplicación: UseCases en vez de un mediator

En los otros generadores un mediator busca en tiempo de ejecución el handler de cada mensaje. En Go eso sería
reflexión en el camino de la petición, así que el registro es un struct generado, `UseCases` (`use_cases.go`),
con **un campo tipado por operación** (`Handler[CreateProductCommand, CreateProductResponseDto]`): un mensaje no
puede llegar a otro caso de uso porque no compila. `NewUseCases` cablea cada handler envuelto con el log de
frontera (`observe`, en `usecase.go`), y la API, los consumidores y el reloj llaman a un campo de `UseCases`.

Por cada operación, build escribe su mensaje (`<operación>_command.go` o `_query.go`, con cabecera de código
generado: no se edita) y el agente su handler (`<operación>_command_handler.go`, sin ella), que nace devolviendo
`ErrNotImplemented` con la operación nombrada. Los mapeos `To<Dto>` van en un archivo por entidad
(`<entidad>_mapper.go`); el que build no sabe derivar entero devuelve además un error con el campo que falta, y
ese archivo también lo completa el agente.

## Por qué `domain` y `application` son un paquete cada uno

Partirlos por agregado abre ciclos de importación en cuanto dos agregados se refieren (una referencia, un
`dispatches`), y Go no los admite. Si un servicio crece tanto que el paquete estorba, se decide con una corrida,
no por adelantado.

## El arranque

`main` solo llama a `run` y convierte su error en el código de salida. `run` recibe el contexto, los argumentos,
las variables de entorno y la salida, así que una prueba lo arranca entero en un puerto libre. Dentro de `run`:

1. la configuración se carga y se valida **antes** de crear nada (`internal/platform/config`);
2. se construyen las piezas y se cablean a mano;
3. el servidor y cada trabajo de fondo corren en un `errgroup`;
4. al cancelarse el contexto (SIGINT o SIGTERM), el apagado va en orden fijo: `/readyz` pasa a 503 → el
   servidor deja de aceptar conexiones y espera a las peticiones en vuelo → se paran consumidores y reloj → se
   drena el relay del outbox → se cierran clientes y pool.

## Configuración

Perfil por `PROFILE` (default `local`), `config/application.yaml` + `config/parameters/<perfil>/*.yaml` en orden
alfabético. Placeholders `${VAR}` (obligatoria) y `${VAR:default}`; las variables de entorno siempre ganan al
YAML. Una obligatoria sin valor no deja arrancar, y se listan todas las que faltan. Es el mismo formato y las
mismas variables que en los otros tres servidores.
