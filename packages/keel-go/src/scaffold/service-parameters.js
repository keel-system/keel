// Parámetros de DESPLIEGUE del servicio (`service.keel.yaml § parameters`, DSL 2.15): un valor único para todo el
// servicio que no es dato de negocio ni entrada de ninguna operación —el plazo tras el que un trabajo se da por
// abandonado, la moneda del catálogo— (tramo 10c). Hasta aquí keel-go los ignoraba EN SILENCIO, el mismo hueco que
// keel-nest y keel-dotnet destaparon en su 10c.
//
// El mismo reparto que en los otros tres, porque la frontera hexagonal es la misma: el dominio no lee configuración, así
// que el valor viaja en un value object de DOMINIO que valida sus cotas al construirse —un parámetro mal puesto tiene que
// tumbar el ARRANQUE, no la primera pasada que lo use— y quien lo puebla desde la configuración es la infraestructura
// (`internal/infrastructure/parameters`). Misma clave (`<artifactId>.<key>`), misma variable de entorno, mismo gradiente
// por perfil (keel-core/gen/service-parameters.js) y las mismas frases, con la forma que Go pide a un error (minúscula y
// sin punto final).
//
// Lo que keel-go todavía no hace es dárselo a un HANDLER: los argumentos del constructor de cada handler los fija build,
// y ningún diseño que keel-go genere lee un parámetro desde una regla. Hoy lo lee el rescate de un barrido
// (`stalledAfter`, DSL 2.18), dentro del adaptador; el que solo lee un handler lo rechaza la frontera con su motivo.

import { parameterProfileValue, parameterProperty } from '@keel-system/keel-core/gen/service-parameters';
import { usesServiceParameters } from '@keel-system/keel-core/gen/features';
import { goExported } from '../lib/go-projection.js';
import { alignRows, goString } from '../lib/go-source.js';
import { domainPath, layout, localName, packageFile } from './render.js';

export { usesServiceParameters };

const PROFILES = ['local', 'develop', 'production', 'test'];

/** Los tipos Go que keel-go sabe leer y validar: los de un plazo (entero) y los de un texto. */
export const SUPPORTED_PARAMETER_TYPES = ['int32', 'int64', 'string'];

/** El value object de dominio: `JobDispatchParameters`. */
export const parametersType = (model) => `${model.service.className}Parameters`;

/** La variable del arranque que lleva los parámetros ya validados (el paquete se llama `parameters`). */
export const PARAMETERS_VAR = 'serviceParameters';

export const PARAMETERS_IMPORT = 'internal/infrastructure/parameters';

/** El accesor de un parámetro: `AbandonAfterMinutes`. */
export const parameterAccessor = (parameter) => goExported(parameter.name);

export function generate(model) {
  if (!usesServiceParameters(model)) return [];
  for (const parameter of model.service.parameters) {
    if (!SUPPORTED_PARAMETER_TYPES.includes(parameter.goType)) {
      throw new Error(`service.parameters.${parameter.name}: keel-go no sabe leer el tipo ${parameter.type}`);
    }
  }
  const { domain, parameters } = layout(model);
  const domainFile = domainPath(model, parametersType(model));
  return [
    { path: domainFile, content: packageFile(model, domain, { imports: ['errors', 'regexp', 'unicode/utf8'], body: domainBody(model) }) },
    {
      path: domainFile.replace(/\.go$/, '_test.go'),
      content: packageFile(model, domain, { test: true, imports: ['strings', 'testing', 'internal/domain'], body: domainTest(model) })
    },
    { path: `${parameters.dir}/parameters.go`, content: packageFile(model, parameters, { doc: PACKAGE_DOC, imports: ['fmt', 'strconv', 'strings', 'internal/domain', 'internal/platform/config'], body: readerBody(model) }) },
    {
      path: `${parameters.dir}/parameters_test.go`,
      content: packageFile(model, parameters, { test: true, imports: ['strings', 'testing', 'testing/fstest', 'internal/infrastructure/parameters', 'internal/platform/config'], body: readerTest(model) })
    },
    ...PROFILES.map((profile) => ({ path: `config/parameters/${profile}/${model.service.artifactId}.yaml`, content: parametersYaml(model, profile) }))
  ];
}

/** El MISMO texto que el fragmento de keel-nest y keel-dotnet. */
export function parametersYaml(model, profile) {
  const lines = [`${model.service.artifactId}:`];
  for (const parameter of model.service.parameters) {
    lines.push(`  # ${parameter.description}`, `  ${parameter.key}: ${parameterProfileValue(parameter, profile)}`);
  }
  return `${lines.join('\n')}\n`;
}

const PACKAGE_DOC = `Package parameters lee los parámetros de despliegue del servicio (service.parameters del diseño) de la configuración
del perfil activo. El dominio valida sus cotas al construirlos: un valor mal puesto no deja arrancar.`;

// ─── El value object de dominio ──────────────────────────────────────────────────────────────────

/** Las frases de los otros tres generadores, como texto de un error de Go. */
const missingMessage = (parameter) => `falta el parámetro de despliegue '${parameter.key}' (variable ${parameter.envVar})`;
const boundMessage = (parameter, what) => `el parámetro '${parameter.key}' ${what}`;
const FORMAT = 'no respeta su formato declarado';
const LENGTH = 'no respeta su longitud declarada';
const RANGE = 'está fuera del rango declarado';

const patternVar = (parameter) => `${localName(parameter.name)}Pattern`;

/** Las guardas de un parámetro en el constructor, sobre su valor ya desreferenciado (`v`). */
function guardsFor(model, parameter) {
  const type = parametersType(model);
  const value = localName(parameter.name);
  const fail = (message) => `\t\treturn ${type}{}, errors.New(${goString(message)})`;
  const lines = [`\tif ${value} == nil {`, fail(missingMessage(parameter)), '\t}'];
  const { pattern, minLength, maxLength, min, max } = parameter.constraints ?? {};
  if (pattern) lines.push(`\tif !${patternVar(parameter)}.MatchString(*${value}) {`, fail(boundMessage(parameter, FORMAT)), '\t}');
  if (minLength != null || maxLength != null) {
    const length = `utf8.RuneCountInString(*${value})`;
    const cond = [minLength != null ? `${length} < ${minLength}` : null, maxLength != null ? `${length} > ${maxLength}` : null].filter(Boolean).join(' || ');
    lines.push(`\tif ${cond} {`, fail(boundMessage(parameter, LENGTH)), '\t}');
  }
  if (min != null || max != null) {
    const cond = [min != null ? `*${value} < ${min}` : null, max != null ? `*${value} > ${max}` : null].filter(Boolean).join(' || ');
    lines.push(`\tif ${cond} {`, fail(boundMessage(parameter, RANGE)), '\t}');
  }
  return lines;
}

function domainBody(model) {
  const type = parametersType(model);
  const parameters = model.service.parameters;
  const patterns = parameters
    .filter((parameter) => parameter.constraints?.pattern)
    // El patrón del diseño, anclado entero: `^(?:…)$` en RE2 es el `\z` de los otros tres (sin multilínea, $ es el final).
    .map((parameter) => `// ${patternVar(parameter)} es el formato declarado de ${parameter.key}.\nvar ${patternVar(parameter)} = regexp.MustCompile(${goString(`^(?:${parameter.constraints.pattern})$`)})`);
  const fields = alignRows(parameters.map((parameter) => ({ indent: '\t', cells: [localName(parameter.name), parameter.goType] })));
  const params = parameters.map((parameter) => `${localName(parameter.name)} *${parameter.goType}`).join(', ');
  const assigns = alignRows(parameters.map((parameter) => ({ indent: '\t\t', cells: [`${localName(parameter.name)}:`, `*${localName(parameter.name)},`] })));
  const accessors = parameters.map(
    (parameter) => `// ${parameterAccessor(parameter)}: ${lowerFirst(parameter.description)}
func (p ${type}) ${parameterAccessor(parameter)}() ${parameter.goType} {
	return p.${localName(parameter.name)}
}`
  );
  return `
${patterns.length > 0 ? `${patterns.join('\n\n')}\n\n` : ''}// ${type} son los parámetros de despliegue de ${model.service.name}, ya validados. Llegan por el cableado del arranque
// a quien los necesita, nunca leyendo la configuración desde el dominio: los puebla internal/infrastructure/parameters
// desde ${model.service.artifactId}.* de la configuración del perfil. Las cotas se comprueban al construirlos.
type ${type} struct {
${fields.join('\n')}
}

// New${type} valida los parámetros contra las cotas que declara el diseño. Un puntero nil es un parámetro sin valor:
// así el error dice QUÉ falta. Un valor ausente o fuera de sus cotas no deja arrancar.
func New${type}(${params}) (${type}, error) {
${parameters.flatMap((parameter) => guardsFor(model, parameter)).join('\n')}
	return ${type}{
${assigns.join('\n')}
	}, nil
}

${accessors.join('\n\n')}
`;
}

function lowerFirst(text) {
  const prose = String(text ?? '').trim();
  const lowered = /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(prose) ? prose[0].toLowerCase() + prose.slice(1) : prose;
  return /[.!?:]$/.test(lowered) ? lowered : `${lowered}.`;
}

/** Un valor del diseño como literal Go del tipo del parámetro. */
function literal(parameter, value) {
  if (parameter.goType === 'string') return goString(String(value));
  return String(value);
}

/** Un valor que rompe el formato: el primero de la lista que no casa con la expresión del diseño. */
function breaking(pattern) {
  const regex = new RegExp(`^(?:${pattern})$`, 'u');
  return ['!', '', 'zz-zz', '0', ' x '].find((candidate) => !regex.test(candidate)) ?? null;
}

/** Los casos de la prueba emitida: el valor de prueba se acepta; ausente y fuera de cotas, no, con su frase. */
function rejections(parameter) {
  const out = [{ value: null, message: missingMessage(parameter) }];
  const { pattern, minLength, maxLength, min, max } = parameter.constraints ?? {};
  if (pattern && parameter.goType === 'string') {
    const value = breaking(pattern);
    if (value != null) out.push({ value: goString(value), message: boundMessage(parameter, FORMAT) });
  }
  // Una longitud fuera de cota puede romper ANTES el formato: de esa solo se afirma que no arranca.
  if (minLength != null && minLength > 0) out.push({ value: goString('x'.repeat(minLength - 1)), message: null });
  if (maxLength != null) out.push({ value: goString('x'.repeat(maxLength + 1)), message: null });
  if (min != null) out.push({ value: String(min - 1), message: boundMessage(parameter, RANGE) });
  if (max != null) out.push({ value: String(max + 1), message: boundMessage(parameter, RANGE) });
  return out;
}

function domainTest(model) {
  const type = parametersType(model);
  const parameters = model.service.parameters;
  const valid = parameters.map((parameter) => literal(parameter, parameter.testValue ?? parameter.default));
  const pointers = parameters.map((parameter, i) => `${localName(parameter.name)} := ${parameter.goType === 'string' ? valid[i] : `${parameter.goType}(${valid[i]})`}`);
  const cases = [];
  parameters.forEach((parameter, index) => {
    for (const rejection of rejections(parameter)) {
      const args = parameters.map((other, i) => {
        if (i !== index) return `&${localName(other.name)}`;
        return rejection.value == null ? 'nil' : `ptr(${other.goType === 'string' ? rejection.value : `${other.goType}(${rejection.value})`})`;
      });
      cases.push({ name: `${parameter.key} = ${rejection.value ?? 'nil'}`, call: `domain.New${type}(${args.join(', ')})`, message: rejection.message });
    }
  });
  const rows = cases.map(
    (c) => `		{${goString(c.name)}, func() error {
			_, err := ${c.call}
			return err
		}, ${goString(c.message ?? '')}},`
  );
  return `
// Los parámetros de despliegue validan al construirse, con las frases de los servidores de keel-spring, keel-nest y
// keel-dotnet del mismo diseño.

func ptr[T any](value T) *T {
	return &value
}

func Test${type}AcceptsTheTestValue(t *testing.T) {
${pointers.map((line) => `\t${line}`).join('\n')}
	parameters, err := domain.New${type}(${parameters.map((parameter) => `&${localName(parameter.name)}`).join(', ')})
	if err != nil {
		t.Fatalf("New${type} = %v, quiero los valores de prueba aceptados", err)
	}
${parameters
  .map(
    (parameter) => `	if got := parameters.${parameterAccessor(parameter)}(); got != ${localName(parameter.name)} {
		t.Errorf("${parameterAccessor(parameter)}() = %v, quiero %v", got, ${localName(parameter.name)})
	}`
  )
  .join('\n')}
}

func Test${type}RefusesMissingOrOutOfBounds(t *testing.T) {
${parameters.length > 1 ? `${pointers.map((line) => `\t${line}`).join('\n')}\n` : ''}	tests := []struct {
		name    string
		build   func() error
		message string
	}{
${rows.join('\n')}
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.build()
			if err == nil {
				t.Fatal("se aceptó, quiero que no deje arrancar")
			}
			if tt.message != "" && !strings.HasPrefix(err.Error(), tt.message) {
				t.Errorf("error = %q, quiero %q", err, tt.message)
			}
		})
	}
}
`;
}

// ─── El lector ───────────────────────────────────────────────────────────────────────────────────

const READERS = { string: 'text', int32: 'int32Of', int64: 'int64Of' };

const READER_CODE = {
  text: `// text es el valor de key sin espacios a los lados, o nil si el perfil no lo declara o lo deja vacío.
func text(cfg *config.Config, key string) (*string, error) {
	value, ok := cfg.Value(key)
	if !ok || strings.TrimSpace(value) == "" {
		return nil, nil
	}
	trimmed := strings.TrimSpace(value)
	return &trimmed, nil
}`,
  int32Of: `// int32Of es el entero de key, o nil si el perfil no lo declara o lo deja vacío.
func int32Of(cfg *config.Config, key string) (*int32, error) {
	value, err := text(cfg, key)
	if value == nil || err != nil {
		return nil, err
	}
	n, err := strconv.ParseInt(*value, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("%s tiene que ser un entero: %q", key, *value)
	}
	parsed := int32(n)
	return &parsed, nil
}`,
  int64Of: `// int64Of es el entero de key, o nil si el perfil no lo declara o lo deja vacío.
func int64Of(cfg *config.Config, key string) (*int64, error) {
	value, err := text(cfg, key)
	if value == nil || err != nil {
		return nil, err
	}
	n, err := strconv.ParseInt(*value, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("%s tiene que ser un entero: %q", key, *value)
	}
	return &n, nil
}`
};

function readerBody(model) {
  const type = parametersType(model);
  const parameters = model.service.parameters;
  const reads = parameters.map(
    (parameter) => `	${localName(parameter.name)}, err := ${READERS[parameter.goType]}(cfg, ${goString(parameterProperty(model, parameter))})
	if err != nil {
		return domain.${type}{}, err
	}`
  );
  const used = new Set(parameters.map((parameter) => READERS[parameter.goType]));
  used.add('text');
  const readers = ['text', 'int32Of', 'int64Of'].filter((reader) => used.has(reader)).map((reader) => READER_CODE[reader]);
  return `
// From lee los parámetros de despliegue del perfil activo (${model.service.artifactId}.* en
// config/parameters/<perfil>/${model.service.artifactId}.yaml) y los valida. Sin defaults aquí a propósito: el gradiente
// por perfil está en ese fragmento, y en producción un parámetro obligatorio sin valor no deja arrancar.
func From(cfg *config.Config) (domain.${type}, error) {
${reads.join('\n')}
	return domain.New${type}(${parameters.map((parameter) => localName(parameter.name)).join(', ')})
}

${readers.join('\n\n')}
`;
}

function readerTest(model) {
  const parameters = model.service.parameters;
  const lines = parameters.map((parameter) => `  ${parameter.key}: ${parameter.goType === 'string' ? JSON.stringify(String(parameter.testValue ?? parameter.default)) : parameter.testValue ?? parameter.default}`);
  const numeric = parameters.find((parameter) => parameter.goType !== 'string');
  const unreadable = numeric
    ? `

func TestFromRefusesANonNumericValue(t *testing.T) {
	_, err := parameters.From(load(t, ${goString(`${model.service.artifactId}:\n  ${numeric.key}: muchos\n`)}))
	if err == nil || !strings.Contains(err.Error(), ${goString(parameterProperty(model, numeric))}) {
		t.Errorf("From = %v, quiero el error de ${parameterProperty(model, numeric)}", err)
	}
}`
    : '';
  return `
// load es la configuración con application.yaml y un fragmento del perfil por defecto con fragment dentro.
func load(t *testing.T, fragment string) *config.Config {
	t.Helper()
	fsys := fstest.MapFS{
		"application.yaml":             {Data: []byte("server:\\n  port: 8080\\n")},
		"parameters/local/params.yaml": {Data: []byte(fragment)},
	}
	cfg, err := config.Load(fsys, func(string) string { return "" })
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func TestFromReadsEveryParameter(t *testing.T) {
	got, err := parameters.From(load(t, ${goString(`${model.service.artifactId}:\n${lines.join('\n')}\n`)}))
	if err != nil {
		t.Fatalf("From = %v, quiero los valores leídos", err)
	}
${parameters
  .map((parameter) => `	if got.${parameterAccessor(parameter)}() != ${literal(parameter, parameter.testValue ?? parameter.default)} {
		t.Errorf("${parameterAccessor(parameter)}() = %v", got.${parameterAccessor(parameter)}())
	}`)
  .join('\n')}
}

func TestFromRefusesAMissingParameter(t *testing.T) {
	_, err := parameters.From(load(t, "other: 1\\n"))
	if err == nil || !strings.Contains(err.Error(), ${goString(missingMessage(parameters[0]))}) {
		t.Errorf("From = %v, quiero el error del parámetro que falta", err)
	}
}${unreadable}
`;
}
