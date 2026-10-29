// README del proyecto generado: de dónde sale, cómo se arranca y qué falta. Pensado también para quien no
// conoce Go: cada comando dice qué hace.

import { describeStack } from '@keel-system/keel-core/gen/stack';
import { GO_MIN_VERSION, GO_TOOLCHAIN } from '../lib/assets.js';
import { layout } from './render.js';

export function generate(model) {
  const { service } = model;
  const pkgs = layout(model);
  return [
    {
      path: 'README.md',
      content: `# ${service.projectName}

${service.description}

Generado desde \`specs/${service.name}\` v${service.version} con \`keel-go\`. El diseño es la fuente de verdad: un
cambio funcional se hace en el workspace de diseño y se vuelve a ejecutar \`keel-go build specs/${service.name}\`.

Stack: ${describeStack(model.stack)}.

## Arrancar

Requiere Go ${GO_MIN_VERSION.replace(/\.0$/, '')} o posterior (\`go version\`); \`go.mod\` fija el toolchain
${GO_TOOLCHAIN}, y un Go más antiguo lo descarga solo. No hace falta nada más instalado: las herramientas
(gotestsum, staticcheck, govulncheck, go-licenses) van en \`go.mod\` y se ejecutan con \`go tool\`.

\`\`\`bash
go mod tidy                       # la primera vez: resuelve las dependencias indirectas y escribe go.sum (commitéalo)
go build ./...                    # compila todos los paquetes
go run ./${pkgs.server.dir}             # PROFILE=local por defecto, puerto 8080
\`\`\`

| Variable | Default | Qué controla |
|---|---|---|
| \`PROFILE\` | \`local\` | Perfil activo (varios separados por coma) |
| \`SERVER_PORT\` | \`8080\` | Puerto HTTP |
| \`SERVER_ADDRESS\` | \`0.0.0.0\` | Interfaz en la que escucha |
| \`SHUTDOWN_TIMEOUT\` | \`30s\` | Margen del apagado ordenado |

Sondas: \`GET /livez\` y \`GET /readyz\` → \`{"status":"UP"}\`; durante el apagado, \`/readyz\` responde 503
\`{"status":"OUT_OF_SERVICE"}\`. La configuración (\`config/\`) va embebida en el binario: cambiarla exige
volver a compilar.

## Pruebas y calidad

\`\`\`bash
go test ./...                     # todas las pruebas, la de la frontera hexagonal incluida
go vet ./...                      # el análisis de la biblioteca estándar
go tool staticcheck ./...         # el lint (vacío = sin hallazgos)
gofmt -l .                        # vacío = todo con el formato de gofmt
go tool govulncheck ./...         # vulnerabilidades conocidas en lo que el servicio llama
\`\`\`

## El módulo

| Paquete | Qué contiene | Puede importar |
|---|---|---|
| \`${pkgs.domain.dir}\` | el dominio | solo la biblioteca estándar y su lista blanca |
| \`${pkgs.application.dir}\` | los casos de uso | el dominio |
| \`${pkgs.httpapi.dir}\` | la entrada HTTP | la aplicación, el dominio y la plataforma |
| \`internal/infrastructure/*\` | un adaptador por tecnología | la aplicación, el dominio y la plataforma |
| \`internal/platform/*\` | configuración, sondas | solo la plataforma |
| \`${pkgs.server.dir}\` | el arranque y el cableado | todo |

La frontera la ejecuta \`${pkgs.architecture.dir}\`: \`internal/\` solo protege frente a otros módulos, no entre
capas del mismo, así que una prueba falla si un import la cruza.
`
    }
  ];
}
