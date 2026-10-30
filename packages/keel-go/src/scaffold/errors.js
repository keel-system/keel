// Errores del dominio: la misma clasificación que keel-spring, keel-nest y keel-dotnet, como VALORES de Go.
//
// En los otros tres es una jerarquía de excepciones (una base por status y una clase por `code`). Go no tiene
// herencia ni excepciones, y la forma idiomática de lo mismo es un tipo de error con su código y errores
// centinela comparados con `errors.Is` (PLAN-KEEL-GO.md § 3.2):
//   · `Kind` es la categoría, el papel de la clase base de su status (`KindNotFound` ↔ NotFoundException);
//   · `*Error` lleva el `code` exacto (contrato público), el status y el mensaje de esa ocurrencia;
//   · un centinela por `code` del diseño (`ErrProductNotFound`) y por error del propio dominio generado (el
//     valor que incumple su tipo, el formato y la transición no declarada);
//   · `Errorf(ErrProductNotFound, "…", args…)` construye una ocurrencia que `errors.Is` reconoce como su
//     centinela, con su mensaje. Nunca se compara por texto.
// Nada conoce net/http: el borde HTTP (internal/httpapi, rest-support.js) traduce `*Error` a la respuesta con `errors.As`.

import { FRAMEWORK_ERRORS } from '@keel-system/keel-core';
import { ERROR_BASES } from '@keel-system/keel-core/gen/error-bases';
import { constraintErrors, declaredConcurrencyError } from '@keel-system/keel-core/gen/constraint-errors';
import { usesRelational } from '@keel-system/keel-core/gen/features';
import { goExported, errorKindFor } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { docComment, domainPath, layout, packageFile } from './render.js';
import { idempotencySentinels } from './request-idempotency.js';

/** El centinela de un `code`: `SKU_ALREADY_EXISTS` → `ErrSKUAlreadyExists`. */
export function sentinelOf(code) {
  return `Err${goExported(String(code).toLowerCase())}`;
}

/** Los errores que emite el propio dominio generado, con su centinela y cuándo hacen falta. */
export function frameworkSentinels(model) {
  const list = [
    {
      name: 'ErrInvalidValue',
      // Un enum que recibe un valor fuera del diseño también lo es: hace falta en cuanto hay tipos propios.
      needed: (model.valueObjects ?? []).length > 0 || (model.enums ?? []).length > 0,
      doc: 'un valor no cumple lo que declara su tipo: presencia, formato, longitud, cotas, escala o un valor de enum que el diseño no tiene. Lo devuelve el constructor del value object, el único punto por el que pasa cualquier valor de ese tipo, venga del cable, de la base de datos o de otro punto del dominio.',
      ...FRAMEWORK_ERRORS.validation
    },
    {
      name: 'ErrValueFormat',
      needed: (model.formatTypes ?? []).length > 0,
      doc: 'un valor no cumple el formato de su value type escalar. Lo devuelve el Validate de su <Tipo>Format. Sobre una petición HTTP el formato ya lo rechaza el lector de entrada: esto es la guarda del dominio para lo que llega por otra puerta (un evento, una operación interna).',
      ...FRAMEWORK_ERRORS.validation
    },
    {
      name: 'ErrInvalidStateTransition',
      needed: (model.entities ?? []).some((entity) => entity.lifecycle),
      doc: 'una transición de lifecycle que el diseño no declara.',
      ...FRAMEWORK_ERRORS.invalidTransition
    }
  ];
  return [...list.filter((entry) => entry.needed), ...persistenceSentinels(model)];
}

/**
 * Los errores que pone la persistencia relacional cuando el diseño no los nombra (docs/framework-errors.md): el
 * conflicto de concurrencia, el tope de transacción, la violación de integridad desconocida (409 SIN code, como
 * keel-spring) y el code CANÓNICO de cada unicidad que el diseño no declara (`<ENTIDAD>_<CAMPOS>_ALREADY_EXISTS`). Los
 * construye el adaptador de PostgreSQL al traducir el error del motor; la tabla de qué constraint es qué error es
 * keel-core/gen/constraint-errors.js, la misma de los otros tres.
 */
export function persistenceSentinels(model) {
  if (!usesRelational(model)) return [];
  const list = [];
  if (!declaredConcurrencyError(model)) {
    list.push({
      name: 'ErrConcurrentModification',
      doc: 'otra escritura cambió el agregado (o lo borró) entre que este caso de uso lo leyó y lo guardó, o un conflicto de escritura transitorio agotó sus reintentos. No se reintenta: el cliente decide con el estado nuevo.',
      ...FRAMEWORK_ERRORS.concurrency
    });
  }
  list.push(
    {
      name: 'ErrTransactionTimeout',
      doc: 'el motor cortó la transacción por su tope (DB_TRANSACTION_TIMEOUT): revirtió entera y es transitorio, así que la API responde 503 con Retry-After.',
      ...FRAMEWORK_ERRORS.transactionTimeout
    },
    {
      name: 'ErrIntegrityViolation',
      doc: 'una violación de integridad que no casa con ninguna constraint conocida: 409 sin code.',
      code: '',
      http: 409
    }
  );
  const seen = new Set(list.map((entry) => entry.name));
  for (const entry of constraintErrors(model)) {
    if (entry.declared) continue;
    const name = sentinelOf(entry.code);
    if (seen.has(name)) continue;
    seen.add(name);
    list.push({ name, doc: `la unicidad de ${entry.entity}.${entry.fields.join(', ')}, que el diseño no nombra: su code canónico.`, code: entry.code, http: 409 });
  }
  // Los dos conflictos del registro de idempotencia (request-idempotency.js), con su code canónico.
  for (const entry of idempotencySentinels(model)) if (!seen.has(entry.name)) list.push(entry);
  return list;
}

export function generate(model) {
  const { domain } = layout(model);
  const framework = frameworkSentinels(model);
  const declared = (model.errors ?? []).map((error) => ({ ...error, name: sentinelOf(error.code) }));
  const taken = new Map(framework.map((entry) => [entry.name, entry.code]));
  for (const error of declared) {
    if (taken.has(error.name)) {
      throw new Error(`errors: el código ${error.code} se escribe en Go ${error.name}, que ya es ${taken.get(error.name)}; renombra el código en el diseño`);
    }
    taken.set(error.name, error.code);
  }
  const dynamic = declared.some((error) => error.dynamicStatus);

  const kinds = alignRows([
    { text: '\t// KindDomain es un error sin categoría propia: su status lo da el propio error.' },
    { indent: '\t', cells: ['KindDomain', 'Kind = iota'] },
    ...ERROR_BASES.flatMap((base) => [
      { text: `\t// ${errorKindFor(base.http)} responde ${base.http}.` },
      { indent: '\t', cells: [errorKindFor(base.http)] }
    ])
  ]);
  const statuses = ERROR_BASES.map((base) => `\tcase ${errorKindFor(base.http)}:\n\t\treturn ${base.http}`).join('\n');

  const sentinel = (entry, kind, status) =>
    `${docComment(entry.name, entry.doc).trimEnd()}\nvar ${entry.name} = &Error{kind: ${kind}, code: ${goString(entry.code)}, status: ${status}}`;
  const frameworkVars = framework.map((entry) => sentinel(entry, errorKindFor(entry.http), entry.http));
  const declaredVars = declared.map((error) => {
    const lines = [`es ${error.code}`];
    if (error.dynamicStatus) {
      const usages = (error.usages ?? []).map((usage) => `${usage.http} en ${usage.operations.join(', ')}`).join('; ');
      lines[0] += `, con un status que depende de la operación (${usages}): constrúyelo con StatusErrorf`;
    } else lines[0] += ` (${error.http})`;
    const doc = `${lines[0]}${error.when ? `. ${error.when}` : '.'}`;
    return error.dynamicStatus
      ? sentinel({ name: error.name, code: error.code, doc }, 'KindDomain', 0)
      : sentinel({ name: error.name, code: error.code, doc }, error.sharedException === 'DomainException' ? 'KindDomain' : error.sharedException, error.http);
  });

  const statusErrorf = dynamic
    ? `

// StatusErrorf es Errorf para un error cuyo status depende de la operación: el diseño declara el mismo code con
// status distintos y quien lo construye sabe cuál toca.
func StatusErrorf(of *Error, status int, format string, args ...any) error {
	return &Error{of: of, kind: of.kind, code: of.code, status: status, message: fmt.Sprintf(format, args...)}
}`
    : '';

  const body = `
// Kind es la categoría de un error de dominio, el papel de la clase base de su status en los otros generadores:
// con ella elige el borde HTTP el status cuando el error no fija uno propio.
type Kind int

const (
${kinds.join('\n')}
)

// Status es el status HTTP de la categoría, o 0 para KindDomain.
func (k Kind) Status() int {
	switch k {
${statuses}
	}
	return 0
}

// Error es un error de dominio: una violación intencionada de una regla de negocio, que no se reintenta. Los de
// infraestructura (un plazo agotado, una conexión caída) no lo son, para poder tratarlos aparte.
//
// Lleva el code estable del error (contrato público), su status y el mensaje de esta ocurrencia. Los centinelas
// (ErrX) no llevan mensaje; una ocurrencia se construye con Errorf y errors.Is la reconoce como su centinela.
type Error struct {
	of      *Error
	kind    Kind
	code    string
	status  int
	message string
}

// Errorf construye una ocurrencia del error of con su mensaje. errors.Is(err, of) la reconoce.
func Errorf(of *Error, format string, args ...any) error {
	return &Error{of: of, kind: of.kind, code: of.code, status: of.status, message: fmt.Sprintf(format, args...)}
}${statusErrorf}

// Error devuelve el mensaje, o el code si el error no lleva uno.
func (e *Error) Error() string {
	if e.message != "" {
		return e.message
	}
	return e.code
}

// Is dice si e es una ocurrencia del centinela target.
func (e *Error) Is(target error) bool {
	return e.of != nil && target == error(e.of)
}

// Kind es la categoría del error.
func (e *Error) Kind() Kind {
	return e.kind
}

// Code es el código estable del error: contrato público, el que afirman los escenarios.
func (e *Error) Code() string {
	return e.code
}

// Status es el status HTTP con el que responde la API: el del error o, si no fija uno, el de su categoría.
func (e *Error) Status() int {
	if e.status != 0 {
		return e.status
	}
	return e.kind.Status()
}

// Message es el mensaje de esta ocurrencia, o "" si no lleva (la API responde entonces con el de su categoría).
func (e *Error) Message() string {
	return e.message
}
${[...frameworkVars, ...declaredVars].map((block) => `\n${block}`).join('\n')}
`;
  return [{ path: domainPath(model, 'errors'), content: packageFile(model, domain, { imports: ['fmt'], body }) }];
}
