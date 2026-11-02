// La correlación (`internal/platform/correlation`): el hilo que une petición HTTP → caso de uso → evento → mensaje
// saliente, y el valor que lleva ErrorResponse. Es el CorrelationContext de keel-spring (ThreadLocal + MDC), de
// keel-nest (AsyncLocalStorage) y de keel-dotnet (AsyncLocal), dicho en Go: viaja en el `context.Context` de la
// petición (§ 3.3), y el Handler de los logs (`logging.js`) lo escribe en cada línea que se escribe con ese contexto.
//
// El formato aceptado es el de los otros tres: el valor llega de FUERA y acaba en logs, cabeceras y eventos, así que
// lo que no lo cumple se sustituye por uno nuevo (nunca se trunca: saldrían ids que se confunden entre sí).

import { usesApi, usesMessaging, usesPersistence } from '@keel-system/keel-core/gen/features';
import { layout, packageFile } from './render.js';

/**
 * ¿Se emite la correlación? La abren la entrada HTTP y el consumo de un mensaje (la de su envoltura), y la llevan los
 * eventos que salen (incremento 9; la mensajería, sobre la persistencia relacional, como en messaging.js).
 */
export function usesCorrelation(model) {
  return usesApi(model) || (usesMessaging(model) && usesPersistence(model));
}

export function generate(model) {
  if (!usesCorrelation(model)) return [];
  const { correlation } = layout(model);
  return [
    {
      path: `${correlation.dir}/correlation.go`,
      content: packageFile(model, correlation, {
        doc: 'Package correlation lleva el identificador de correlación de la petición o del mensaje en curso: el\nhilo que une la entrada, el caso de uso y lo que sale de él. Viaja en el contexto.',
        imports: ['context', 'regexp', 'github.com/google/uuid'],
        body: CORRELATION_BODY
      })
    },
    {
      path: `${correlation.dir}/correlation_test.go`,
      content: packageFile(model, correlation, {
        test: true,
        imports: ['regexp', 'strings', 'testing', 'internal/platform/correlation'],
        body: CORRELATION_TEST
      })
    }
  ];
}

const CORRELATION_BODY = `
// Header es la cabecera HTTP por la que llega y vuelve la correlación.
const Header = "X-Correlation-Id"

// accepted es lo que se acepta como correlationId recibido: sin cota, un cliente podría meter saltos de línea o
// kilobytes en cada registro.
var accepted = regexp.MustCompile(\`^[A-Za-z0-9._-]{1,64}$\`)

// Accept devuelve el correlationId EFECTIVO para un valor recibido: el mismo si cumple el formato, o uno nuevo si
// no llegó o no lo cumple.
func Accept(received string) string {
	if accepted.MatchString(received) {
		return received
	}
	return uuid.NewString()
}

type contextKey struct{}

// WithID devuelve un contexto que lleva el correlationId id.
func WithID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, contextKey{}, id)
}

// ID es el correlationId del contexto y si lo lleva.
func ID(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(contextKey{}).(string)
	return id, ok
}
`;

const CORRELATION_TEST = `
var generated = regexp.MustCompile(\`^[0-9a-f-]{36}$\`)

func TestAcceptConservaLoQueCumpleElFormatoYSustituyeLoDemas(t *testing.T) {
	if got := correlation.Accept("pedido-42"); got != "pedido-42" {
		t.Errorf("Accept(pedido-42) = %q, quiero el mismo", got)
	}
	for _, received := range []string{"", "con espacios", "linea\\nnueva", strings.Repeat("a", 65)} {
		if got := correlation.Accept(received); !generated.MatchString(got) {
			t.Errorf("Accept(%q) = %q, quiero uno nuevo", received, got)
		}
	}
}

func TestElContextoLlevaLaCorrelacion(t *testing.T) {
	if _, ok := correlation.ID(t.Context()); ok {
		t.Fatal("un contexto sin correlación dice llevar una")
	}
	ctx := correlation.WithID(t.Context(), "pedido-42")
	if id, ok := correlation.ID(ctx); !ok || id != "pedido-42" {
		t.Fatalf("ID = %q, %v; quiero pedido-42", id, ok)
	}
}
`;
