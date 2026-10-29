// El CONTRATO DEL CABLE en el proyecto Go (keel-core/gen/wire.js): el paquete `internal/platform/wire`, por el
// que pasa todo cuerpo JSON, los tipos que la biblioteca estándar no tiene y la prueba que los ejecuta contra los
// casos compartidos.
//
// Va sobre `encoding/json/v2` (estable desde Go 1.27: por eso es la versión mínima, src/lib/assets.js), que ya
// hace por defecto lo que el contrato pide y el v1 no:
//   · una lista sin elementos se escribe `[]`, no `null` (list-never-null);
//   · los nombres se comparan EXACTOS, como Jackson (el v1 casaba `CustomerId` con `customerId`);
//   · una propiedad desconocida se ignora, un segundo valor tras el cuerpo se rechaza y no se escapa lo que no
//     es ASCII ni lo que solo es peligroso dentro de HTML (string-utf8).
// Y admite un conversor por tipo en cada llamada (WithMarshalers/WithUnmarshalers), que es donde se resuelve lo
// que no hace a pelo:
//   · `time.Time` sale con nueve decimales y la zona que lleve: el contrato pide UTC, `Z` y tres, truncando, y
//     al leer exige la zona;
//   · `int64` e `int32` no se leen de una cadena numérica (long-exact); el de 32 bits es el `int` del DSL;
//   · `jsontext.Value` no se lee de una cadena con el documento ya serializado (json-embedded).
// Lo que se decide aquí y no viene del contrato: un nombre repetido en un objeto no se rechaza (el v2 lo hace por
// defecto) sino que gana el último, como en Jackson, Node y System.Text.Json; un 400 que los otros tres no dan
// sería otra respuesta para el mismo cuerpo.
//
// `Decimal` es propio, sobre math/big, y no de una librería (medido en el inc. 3): shopspring/decimal NORMALIZA
// (2.50 sale 2.5) y cockroachdb/apd conserva la escala pero escribe en exponencial (1E-7, 1E+3) y es mutable, así
// que copiar uno por valor comparte su big.Int. El propio tiene la semántica de BigDecimal —la misma que
// reproducen keel-nest y keel-dotnet—, es inmutable y deja al dominio sin un módulo de terceros más.

import { WIRE_OUTPUT_CASES, WIRE_INPUT_CASES, WIRE_REJECTED_INPUTS } from '@keel-system/keel-core/gen/wire';
import { enumConstant } from '../lib/go-projection.js';
import { goString } from '../lib/go-source.js';
import { layout, packageFile } from './render.js';

/**
 * Los dígitos que puede tener la forma plana de un decimal que se lee: `1E-1000000000` son trece caracteres y mil
 * millones de dígitos. Es un solo límite a propósito: con uno para el texto y otro para la escala, el fuzzing
 * encontró `100000E1000`, que se aceptaba y cuya forma plana ya no se podía volver a leer.
 */
export const MAX_DIGITS = 1000;

/**
 * La tabla de la documentación de `java.math.RoundingMode`: cada valor redondeado a entero con cada modo. Es el
 * oráculo de los modos, porque el diseño habla el vocabulario de BigDecimal.
 */
export const ROUNDING_TABLE = {
  inputs: ['5.5', '2.5', '1.6', '1.1', '1.0', '-1.0', '-1.1', '-1.6', '-2.5', '-5.5'],
  modes: {
    RoundUp: ['6', '3', '2', '2', '1', '-1', '-2', '-2', '-3', '-6'],
    RoundDown: ['5', '2', '1', '1', '1', '-1', '-1', '-1', '-2', '-5'],
    RoundCeiling: ['6', '3', '2', '2', '1', '-1', '-1', '-1', '-2', '-5'],
    RoundFloor: ['5', '2', '1', '1', '1', '-1', '-2', '-2', '-3', '-6'],
    RoundHalfUp: ['6', '3', '2', '1', '1', '-1', '-1', '-2', '-3', '-6'],
    RoundHalfDown: ['5', '2', '2', '1', '1', '-1', '-1', '-2', '-2', '-5'],
    RoundHalfEven: ['6', '2', '2', '1', '1', '-1', '-1', '-2', '-2', '-6']
  }
};

export function generate(model) {
  const { wire } = layout(model);
  return [
    { path: `${wire.dir}/wire.go`, content: wireGo(model) },
    { path: `${wire.dir}/decimal.go`, content: decimalGo(model) },
    { path: `${wire.dir}/date.go`, content: dateGo(model) },
    { path: `${wire.dir}/optional.go`, content: optionalGo(model) },
    { path: `${wire.dir}/wire_test.go`, content: wireTestGo(model) },
    { path: `${wire.dir}/decimal_test.go`, content: decimalTestGo(model) },
    { path: `${wire.dir}/fuzz_test.go`, content: fuzzTestGo(model) }
  ];
}

const JSON_IMPORTS = ['encoding/json/jsontext', 'encoding/json/v2'];

function wireGo(model) {
  const { wire } = layout(model);
  return packageFile(model, wire, {
    doc: `Package wire es el contrato del cable del servicio: cómo viaja en JSON cada tipo del diseño. Es contrato
observable, el mismo que cumplen los servidores de keel-spring, keel-nest y keel-dotnet del mismo diseño, y
wire_test.go lo ejecuta contra sus casos.

Todo cuerpo JSON se lee y se escribe con Marshal, Unmarshal, MarshalWrite y UnmarshalRead: un solo punto, con
encoding/json/v2 y las reglas de este paquete. Los tipos que la biblioteca estándar no tiene (Decimal, Date y
Optional) viven aquí, y el dominio los usa.`,
    imports: ['cmp', 'errors', 'fmt', 'io', 'regexp', 'strconv', 'strings', 'time', ...JSON_IMPORTS],
    body: `
// options son las del contrato; no cambian después de arrancar.
var options = json.JoinOptions(
	// Un nombre repetido en un objeto no se rechaza: gana el último, como en Jackson, Node y System.Text.Json.
	jsontext.AllowDuplicateNames(true),
	json.WithMarshalers(json.MarshalToFunc(marshalTimestamp)),
	json.WithUnmarshalers(json.JoinUnmarshalers(
		json.UnmarshalFromFunc(unmarshalTimestamp),
		json.UnmarshalFromFunc(unmarshalInt64),
		json.UnmarshalFromFunc(unmarshalInt32),
		json.UnmarshalFromFunc(unmarshalValue),
	)),
)

// Options devuelve las opciones del contrato, para quien lea o escriba JSON con encoding/json/v2 directamente.
func Options() json.Options {
	return options
}

// Marshal escribe v con el contrato del cable.
func Marshal(v any) ([]byte, error) {
	return json.Marshal(v, options)
}

// MarshalWrite escribe v en w con el contrato del cable.
func MarshalWrite(w io.Writer, v any) error {
	return json.MarshalWrite(w, v, options)
}

// Unmarshal lee data en v con el contrato del cable. Un segundo valor tras el primero es un error.
func Unmarshal(data []byte, v any) error {
	return json.Unmarshal(data, v, options)
}

// UnmarshalRead lee r entero en v con el contrato del cable. Un segundo valor tras el primero es un error.
func UnmarshalRead(r io.Reader, v any) error {
	return json.UnmarshalRead(r, v, options)
}

// TimestampLayout es la forma del cable de un instante: UTC, exactamente tres decimales y Z.
const TimestampLayout = "2006-01-02T15:04:05.000Z"

// timestampPattern es un instante ISO-8601 CON zona; los segundos y la fracción son opcionales.
var timestampPattern = regexp.MustCompile(\`^(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?(Z|[+-]\\d{2}:\\d{2})$\`)

// FormatTimestamp escribe un instante como viaja: en UTC, con tres decimales y Z. Lo que hay por debajo del
// milisegundo se trunca, no se redondea.
func FormatTimestamp(t time.Time) string {
	return t.UTC().Truncate(time.Millisecond).Format(TimestampLayout)
}

// ParseTimestamp lee un instante ISO-8601 con zona (Z o ±hh:mm), también de la ruta o de la query: lo normaliza
// a UTC y descarta lo que hay por debajo del milisegundo. Sin zona no es un instante.
func ParseTimestamp(text string) (time.Time, error) {
	m := timestampPattern.FindStringSubmatch(text)
	if m == nil {
		return time.Time{}, fmt.Errorf("%q no es un instante ISO-8601 con zona", text)
	}
	millis := (m[4] + "000")[:3]
	t, err := time.Parse(time.RFC3339, m[1]+"T"+m[2]+":"+cmp.Or(m[3], "00")+"."+millis+m[5])
	if err != nil {
		return time.Time{}, fmt.Errorf("el instante %q no existe: %w", text, err)
	}
	return t.UTC(), nil
}

// integerPattern es un entero en base 10, con signo menos opcional.
var integerPattern = regexp.MustCompile(\`^-?\\d+$\`)

// ParseInt64 lee el long del diseño de un texto (una cadena numérica del cable, la ruta o la query).
func ParseInt64(text string) (int64, error) {
	return parseInteger(text, 64)
}

// ParseInt32 lee el int del diseño, de 32 bits como en Java y C#: fuera de rango es un error, no otro número.
func ParseInt32(text string) (int32, error) {
	v, err := parseInteger(text, 32)
	return int32(v), err
}

func parseInteger(text string, bits int) (int64, error) {
	trimmed := strings.TrimSpace(text)
	if !integerPattern.MatchString(trimmed) {
		return 0, fmt.Errorf("%q no es un entero", text)
	}
	v, err := strconv.ParseInt(trimmed, 10, bits)
	if err != nil {
		return 0, fmt.Errorf("%q no cabe en un entero de %d bits: %w", text, bits, err)
	}
	return v, nil
}

// errNotTimestamp es lo que se lee en un instante cuando no llega una cadena.
var errNotTimestamp = errors.New("se esperaba un instante ISO-8601 con zona")

func marshalTimestamp(enc *jsontext.Encoder, t time.Time) error {
	return enc.WriteToken(jsontext.String(FormatTimestamp(t)))
}

func unmarshalTimestamp(dec *jsontext.Decoder, out *time.Time) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	switch tok.Kind() {
	case 'n':
		*out = time.Time{}
		return nil
	case '"':
		t, err := ParseTimestamp(tok.String())
		if err != nil {
			return err
		}
		*out = t
		return nil
	default:
		return errNotTimestamp
	}
}

// unmarshalInt64 lee un long también de una cadena numérica; un número lo lee encoding/json/v2, que ya rechaza
// la fracción y el desbordamiento.
func unmarshalInt64(dec *jsontext.Decoder, out *int64) error {
	text, ok, err := numericString(dec)
	if !ok {
		return err
	}
	v, err := ParseInt64(text)
	if err != nil {
		return err
	}
	*out = v
	return nil
}

// unmarshalInt32 es unmarshalInt64 para el int del diseño.
func unmarshalInt32(dec *jsontext.Decoder, out *int32) error {
	text, ok, err := numericString(dec)
	if !ok {
		return err
	}
	v, err := ParseInt32(text)
	if err != nil {
		return err
	}
	*out = v
	return nil
}

// numericString lee el texto de una cadena; con cualquier otro valor no consume nada y devuelve
// errors.ErrUnsupported, que deja la lectura a encoding/json/v2.
func numericString(dec *jsontext.Decoder) (string, bool, error) {
	if dec.PeekKind() != '"' {
		return "", false, errors.ErrUnsupported
	}
	tok, err := dec.ReadToken()
	if err != nil {
		return "", false, err
	}
	return tok.String(), true, nil
}

// unmarshalValue lee un campo json del diseño: embebido, o como cadena con el documento ya serializado. Se
// guarda compacto, que es como lo escriben los otros tres servidores.
func unmarshalValue(dec *jsontext.Decoder, out *jsontext.Value) error {
	var value jsontext.Value
	if dec.PeekKind() == '"' {
		tok, err := dec.ReadToken()
		if err != nil {
			return err
		}
		value = jsontext.Value(tok.String())
		if !value.IsValid() {
			return errors.New("la cadena no contiene un documento JSON")
		}
	} else {
		read, err := dec.ReadValue()
		if err != nil {
			return err
		}
		value = read.Clone()
	}
	if err := value.Compact(); err != nil {
		return fmt.Errorf("compactar el documento: %w", err)
	}
	*out = value
	return nil
}
`
  });
}

function decimalGo(model) {
  const { wire } = layout(model);
  return packageFile(model, wire, {
    imports: ['errors', 'fmt', 'math/big', 'regexp', 'strconv', 'strings', ...JSON_IMPORTS],
    body: `
// Decimal es un decimal EXACTO con su escala, con la semántica de BigDecimal de Java: 2.50 y 2.5 son la misma
// cantidad (Cmp los da iguales) pero no el mismo valor del cable, porque la escala viaja. Es inmutable, así que
// se copia por valor sin compartir nada que alguien pueda modificar, y su valor cero es 0 con escala 0.
//
// Nunca float64 para un importe: es binario y no representa exactamente 0.1. La suma toma la mayor de las dos
// escalas, el producto la suma de las dos y la división pide escala y redondeo, porque un cociente no tiene una
// escala natural.
type Decimal struct {
	// unscaled es el valor sin la coma: 2.50 es 250 con escala 2. nil es cero. No se modifica nunca.
	unscaled *big.Int
	scale    int32
}

// RoundingMode es cómo se redondea al perder decimales. Son los modos de java.math.RoundingMode, que es el
// vocabulario del diseño; el valor cero es RoundHalfUp.
type RoundingMode int

const (
	// RoundHalfUp va al más cercano, y en el empate se aleja del cero. Es el de scalePolicy: round.
	RoundHalfUp RoundingMode = iota
	// RoundHalfDown va al más cercano, y en el empate se acerca al cero.
	RoundHalfDown
	// RoundHalfEven va al más cercano, y en el empate al par (el redondeo del banquero).
	RoundHalfEven
	// RoundUp se aleja del cero.
	RoundUp
	// RoundDown se acerca al cero: trunca.
	RoundDown
	// RoundCeiling va hacia más infinito.
	RoundCeiling
	// RoundFloor va hacia menos infinito.
	RoundFloor
)

// MaxDigits es el mayor número de dígitos de la forma plana de un decimal que se lee (los de 0.001 son cuatro):
// un literal como 1E-1000000000 son trece caracteres y mil millones de dígitos. Es el maxNumberLength de las
// StreamReadConstraints de Jackson. Lo que se acepta se puede volver a leer: su forma plana cabe en el límite.
const MaxDigits = ${MAX_DIGITS}

// ErrDivisionByZero es el error de dividir por cero.
var ErrDivisionByZero = errors.New("división por cero")

// decimalPattern es un literal decimal: signo, dígitos con punto opcional y exponente opcional.
var decimalPattern = regexp.MustCompile(\`^[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?$\`)

// ParseDecimal lee un decimal EXACTO de su texto (2.50, -0.5, 1E-7), también de una cadena del cable, de la ruta
// o de la query. La escala es la que escribe el literal: 1E-7 tiene escala 7 y 2.50E1 es 25.0.
func ParseDecimal(text string) (Decimal, error) {
	s := strings.TrimSpace(text)
	if len(s) > 2*MaxDigits || !decimalPattern.MatchString(s) {
		return Decimal{}, fmt.Errorf("%q no es un decimal", text)
	}
	mantissa, exponent, _ := strings.Cut(strings.ToLower(s), "e")
	var exp int64
	if exponent != "" {
		var err error
		if exp, err = strconv.ParseInt(exponent, 10, 32); err != nil {
			return Decimal{}, fmt.Errorf("el decimal %q está fuera de rango: %w", text, err)
		}
	}
	whole, fraction, _ := strings.Cut(mantissa, ".")
	scale := int64(len(fraction)) - exp
	// Antes de multiplicar por 10^-scale: con el exponente sin acotar, eso ya es el problema.
	if scale > MaxDigits || scale < -MaxDigits {
		return Decimal{}, fmt.Errorf("el decimal %q está fuera de rango (escala %d)", text, scale)
	}
	unscaled, ok := new(big.Int).SetString(whole+fraction, 10)
	if !ok {
		return Decimal{}, fmt.Errorf("%q no es un decimal", text)
	}
	d := normalized(unscaled, scale)
	if d.digits() > MaxDigits {
		return Decimal{}, fmt.Errorf("el decimal %q tiene más de %d dígitos", text, MaxDigits)
	}
	return d, nil
}

// digits es el número de dígitos de la forma plana, sin el signo ni el punto.
func (d Decimal) digits() int {
	return max(len(new(big.Int).Abs(d.value()).String()), int(d.scale)+1)
}

// MustDecimal es ParseDecimal para un literal que escribe el programador (un default del diseño): uno mal escrito
// es un error de programación, no de la entrada.
func MustDecimal(text string) Decimal {
	d, err := ParseDecimal(text)
	if err != nil {
		panic(err)
	}
	return d
}

// NewDecimal es el decimal unscaled·10^-scale: NewDecimal(250, 2) es 2.50. Una escala negativa multiplica:
// NewDecimal(5, -2) es 500.
func NewDecimal(unscaled int64, scale int32) Decimal {
	return normalized(big.NewInt(unscaled), int64(scale))
}

// normalized es el decimal con escala no negativa: el cable no tiene notación para 5E+2 que no sea 500.
func normalized(unscaled *big.Int, scale int64) Decimal {
	if scale < 0 {
		return Decimal{unscaled: unscaled.Mul(unscaled, pow10(-scale))}
	}
	return Decimal{unscaled: unscaled, scale: int32(scale)}
}

func pow10(n int64) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(n), nil)
}

// value es el valor sin la coma, nunca nil. Quien lo recibe no lo modifica.
func (d Decimal) value() *big.Int {
	if d.unscaled == nil {
		return new(big.Int)
	}
	return d.unscaled
}

// at es el valor sin la coma con la escala scale, que no es menor que la de d.
func (d Decimal) at(scale int32) *big.Int {
	if scale == d.scale {
		return d.value()
	}
	return new(big.Int).Mul(d.value(), pow10(int64(scale-d.scale)))
}

// Scale es el número de decimales con los que se escribe.
func (d Decimal) Scale() int32 {
	return d.scale
}

// Sign es -1, 0 o 1 según el signo.
func (d Decimal) Sign() int {
	return d.value().Sign()
}

// Cmp compara la CANTIDAD, que es la comparación de negocio: 2.5 y 2.50 son iguales aquí.
func (d Decimal) Cmp(other Decimal) int {
	scale := max(d.scale, other.scale)
	return d.at(scale).Cmp(other.at(scale))
}

// Equal es la igualdad de VALOR, la del equals de BigDecimal: la misma cantidad y la misma escala. 2.5 y 2.50
// son distintos aquí, porque viajan distinto; por eso un value object normaliza la escala al construirse.
// go-cmp la usa al comparar.
func (d Decimal) Equal(other Decimal) bool {
	return d.scale == other.scale && d.Cmp(other) == 0
}

// Add es d + other, con la mayor de las dos escalas.
func (d Decimal) Add(other Decimal) Decimal {
	scale := max(d.scale, other.scale)
	return Decimal{unscaled: new(big.Int).Add(d.at(scale), other.at(scale)), scale: scale}
}

// Sub es d - other, con la mayor de las dos escalas.
func (d Decimal) Sub(other Decimal) Decimal {
	scale := max(d.scale, other.scale)
	return Decimal{unscaled: new(big.Int).Sub(d.at(scale), other.at(scale)), scale: scale}
}

// Mul es d · other, con la suma de las dos escalas.
func (d Decimal) Mul(other Decimal) Decimal {
	return Decimal{unscaled: new(big.Int).Mul(d.value(), other.value()), scale: d.scale + other.scale}
}

// Neg es -d, con la misma escala.
func (d Decimal) Neg() Decimal {
	return Decimal{unscaled: new(big.Int).Neg(d.value()), scale: d.scale}
}

// Abs es |d|, con la misma escala.
func (d Decimal) Abs() Decimal {
	return Decimal{unscaled: new(big.Int).Abs(d.value()), scale: d.scale}
}

// Quo es d / other con scale decimales, redondeado con mode. Dividir por cero es ErrDivisionByZero.
func (d Decimal) Quo(other Decimal, scale int32, mode RoundingMode) (Decimal, error) {
	if other.Sign() == 0 {
		return Decimal{}, ErrDivisionByZero
	}
	// (u·10^-s) / (v·10^-t) con escala k es u·10^(k+t-s) / v.
	num, den := new(big.Int).Set(d.value()), new(big.Int).Set(other.value())
	if shift := int64(scale) + int64(other.scale) - int64(d.scale); shift >= 0 {
		num.Mul(num, pow10(shift))
	} else {
		den.Mul(den, pow10(-shift))
	}
	return normalized(quoRound(num, den, mode), int64(scale)), nil
}

// Rescale es d con scale decimales: si gana decimales los añade a cero; si los pierde, redondea con mode. Una
// escala negativa redondea a decenas, centenas…: 125 con escala -1 es 130 (HalfUp).
func (d Decimal) Rescale(scale int32, mode RoundingMode) Decimal {
	if scale >= d.scale {
		return Decimal{unscaled: d.at(scale), scale: scale}
	}
	return normalized(quoRound(d.value(), pow10(int64(d.scale)-int64(scale)), mode), int64(scale))
}

// quoRound es num / den redondeado a entero con mode.
func quoRound(num, den *big.Int, mode RoundingMode) *big.Int {
	q, r := new(big.Int).QuoRem(num, den, new(big.Int))
	if r.Sign() == 0 {
		return q
	}
	// El signo del cociente exacto, y si el resto es menos, justo o más de la mitad del divisor.
	sign := num.Sign() * den.Sign()
	half := new(big.Int).Lsh(new(big.Int).Abs(r), 1).Cmp(new(big.Int).Abs(den))
	var away bool
	switch mode {
	case RoundHalfUp:
		away = half >= 0
	case RoundHalfDown:
		away = half > 0
	case RoundHalfEven:
		away = half > 0 || (half == 0 && q.Bit(0) == 1)
	case RoundUp:
		away = true
	case RoundDown:
		away = false
	case RoundCeiling:
		away = sign > 0
	case RoundFloor:
		away = sign < 0
	}
	if away {
		q.Add(q, big.NewInt(int64(sign)))
	}
	return q
}

// String es la forma del cable: notación plana con exactamente Scale decimales (0.0000001, nunca 1E-7).
func (d Decimal) String() string {
	digits := d.value().String()
	sign := ""
	if digits[0] == '-' {
		sign, digits = "-", digits[1:]
	}
	if d.scale == 0 {
		return sign + digits
	}
	if pad := int(d.scale) + 1 - len(digits); pad > 0 {
		digits = strings.Repeat("0", pad) + digits
	}
	cut := len(digits) - int(d.scale)
	return sign + digits[:cut] + "." + digits[cut:]
}

// MarshalJSONTo escribe el decimal como número JSON, con su escala y en notación plana.
func (d Decimal) MarshalJSONTo(enc *jsontext.Encoder) error {
	return enc.WriteValue(jsontext.Value(d.String()))
}

// UnmarshalJSONFrom lee el decimal exacto del texto del número, o de una cadena numérica.
func (d *Decimal) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	switch tok.Kind() {
	case 'n':
		*d = Decimal{}
		return nil
	case '0', '"':
		parsed, err := ParseDecimal(tok.String())
		if err != nil {
			return err
		}
		*d = parsed
		return nil
	default:
		return fmt.Errorf("se esperaba un decimal, no %v", tok.Kind())
	}
}

var _ json.MarshalerTo = Decimal{}
`
  });
}

function dateGo(model) {
  const { wire } = layout(model);
  return packageFile(model, wire, {
    imports: ['cmp', 'errors', 'fmt', 'regexp', 'time', ...JSON_IMPORTS],
    body: `
// Date es una fecha sin hora ni zona (el date del diseño): viaja como YYYY-MM-DD. Su valor cero no es una fecha
// (IsZero) y no se escribe: un campo opcional es un *Date.
type Date struct {
	year  int
	month time.Month
	day   int
}

// datePattern es la forma del cable: cuatro dígitos de año y dos de mes y de día, sin nada más.
var datePattern = regexp.MustCompile(\`^\\d{4}-\\d{2}-\\d{2}$\`)

// errZeroDate es lo que da escribir una Date que nadie asignó.
var errZeroDate = errors.New("fecha sin valor")

// NewDate es la fecha del calendario; una que no existe (30 de febrero) es un error.
func NewDate(year int, month time.Month, day int) (Date, error) {
	t := time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
	if t.Year() != year || t.Month() != month || t.Day() != day {
		return Date{}, fmt.Errorf("la fecha %04d-%02d-%02d no existe", year, int(month), day)
	}
	return Date{year: year, month: month, day: day}, nil
}

// DateOf es la fecha civil de t en su zona.
func DateOf(t time.Time) Date {
	year, month, day := t.Date()
	return Date{year: year, month: month, day: day}
}

// ParseDate lee una fecha YYYY-MM-DD que exista, también de la ruta o de la query.
func ParseDate(text string) (Date, error) {
	if !datePattern.MatchString(text) {
		return Date{}, fmt.Errorf("%q no es una fecha YYYY-MM-DD", text)
	}
	t, err := time.Parse(time.DateOnly, text)
	if err != nil {
		return Date{}, fmt.Errorf("la fecha %q no existe: %w", text, err)
	}
	return DateOf(t), nil
}

// MustDate es ParseDate para un literal que escribe el programador.
func MustDate(text string) Date {
	d, err := ParseDate(text)
	if err != nil {
		panic(err)
	}
	return d
}

// Year es el año.
func (d Date) Year() int {
	return d.year
}

// Month es el mes.
func (d Date) Month() time.Month {
	return d.month
}

// Day es el día del mes.
func (d Date) Day() int {
	return d.day
}

// IsZero dice si la fecha no tiene valor.
func (d Date) IsZero() bool {
	return d == Date{}
}

// Compare es -1, 0 o 1 según d sea anterior, igual o posterior a other.
func (d Date) Compare(other Date) int {
	return cmp.Or(cmp.Compare(d.year, other.year), cmp.Compare(d.month, other.month), cmp.Compare(d.day, other.day))
}

// Time es el comienzo del día en UTC.
func (d Date) Time() time.Time {
	return time.Date(d.year, d.month, d.day, 0, 0, 0, 0, time.UTC)
}

// String es la forma del cable, YYYY-MM-DD.
func (d Date) String() string {
	return fmt.Sprintf("%04d-%02d-%02d", d.year, int(d.month), d.day)
}

// MarshalJSONTo escribe la fecha como cadena YYYY-MM-DD.
func (d Date) MarshalJSONTo(enc *jsontext.Encoder) error {
	if d.IsZero() {
		return errZeroDate
	}
	return enc.WriteToken(jsontext.String(d.String()))
}

// UnmarshalJSONFrom lee una fecha YYYY-MM-DD que exista.
func (d *Date) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	switch tok.Kind() {
	case 'n':
		*d = Date{}
		return nil
	case '"':
		parsed, err := ParseDate(tok.String())
		if err != nil {
			return err
		}
		*d = parsed
		return nil
	default:
		return fmt.Errorf("se esperaba una fecha YYYY-MM-DD, no %v", tok.Kind())
	}
}

var _ json.MarshalerTo = Date{}
`
  });
}

function optionalGo(model) {
  const { wire } = layout(model);
  return packageFile(model, wire, {
    imports: JSON_IMPORTS,
    body: `
// Optional es un campo de un PATCH con sus tres estados: ausente (no se toca), null (se vacía) o con valor. Su
// valor cero es «ausente», y con la opción omitzero del tag uno ausente no se escribe.
type Optional[T any] struct {
	value   T
	present bool
	null    bool
}

// Some es un Optional con valor.
func Some[T any](value T) Optional[T] {
	return Optional[T]{value: value, present: true}
}

// Null es un Optional que vino a null: vaciar el campo.
func Null[T any]() Optional[T] {
	return Optional[T]{present: true, null: true}
}

// Present dice si el campo vino en la entrada, a null o con valor.
func (o Optional[T]) Present() bool {
	return o.present
}

// IsNull dice si el campo vino a null.
func (o Optional[T]) IsNull() bool {
	return o.present && o.null
}

// Get devuelve el valor y si lo hay: no lo hay si el campo no vino o vino a null.
func (o Optional[T]) Get() (T, bool) {
	return o.value, o.present && !o.null
}

// IsZero dice si el campo no vino. Es lo que mira omitzero.
func (o Optional[T]) IsZero() bool {
	return !o.present
}

// MarshalJSONTo escribe null o el valor, con las mismas opciones que el objeto que lo contiene.
func (o Optional[T]) MarshalJSONTo(enc *jsontext.Encoder) error {
	if !o.present || o.null {
		return enc.WriteToken(jsontext.Null)
	}
	return json.MarshalEncode(enc, o.value)
}

// UnmarshalJSONFrom lee el campo, que por llegar ya no es ausente.
func (o *Optional[T]) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	if dec.PeekKind() == 'n' {
		if _, err := dec.ReadToken(); err != nil {
			return err
		}
		*o = Null[T]()
		return nil
	}
	var value T
	if err := json.UnmarshalDecode(dec, &value); err != nil {
		return err
	}
	*o = Some(value)
	return nil
}
`
  });
}

/** Los valores de enum de los casos: la prueba los declara como un enum con el valor del diseño. */
function enumValues() {
  return [...new Set([...WIRE_OUTPUT_CASES, ...WIRE_INPUT_CASES, ...WIRE_REJECTED_INPUTS].filter((entry) => entry.type === 'enum').map((entry) => entry.value))];
}

const caseLine = (fields) => `\t\t{${Object.entries(fields).map(([key, value]) => `${key}: ${goString(value)}`).join(', ')}},`;

function wireTestGo(model) {
  const { wire } = layout(model);
  const constants = enumValues().map((value) => `\t${enumConstant('sampleStatus', value)} sampleStatus = ${goString(value)}`);
  const arms = enumValues().map((value) => enumConstant('sampleStatus', value)).join(', ');
  return packageFile(model, wire, {
    test: true,
    imports: ['fmt', 'strconv', 'testing', 'time', 'github.com/google/uuid', ...JSON_IMPORTS, 'internal/platform/wire'],
    body: `
// El contrato del cable, ejecutado. Los casos los genera keel-go desde keel-core/gen/wire.js, la misma fuente
// contra la que se miden los servidores de keel-spring, keel-nest y keel-dotnet: si uno de estos falla, este
// servidor y los otros tres del mismo diseño ya no responden igual.

// sampleStatus es un enum como los que emite el dominio: el valor del diseño es el que viaja.
type sampleStatus string

const (
${constants.join('\n')}
)

// UnmarshalText solo admite los valores del diseño.
func (s *sampleStatus) UnmarshalText(text []byte) error {
	switch v := sampleStatus(text); v {
	case ${arms}:
		*s = v
		return nil
	}
	return fmt.Errorf("%q no es un valor del enum", text)
}

func marshal(t *testing.T, v any) string {
	t.Helper()
	out, err := wire.Marshal(v)
	if err != nil {
		t.Fatalf("escribir %v: %v", v, err)
	}
	return string(out)
}

// typed es el valor del tipo del diseño a partir de su literal.
func typed(t *testing.T, typ, literal string) any {
	t.Helper()
	switch typ {
	case "decimal":
		return wire.MustDecimal(literal)
	case "long":
		v, err := strconv.ParseInt(literal, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		return v
	case "int":
		v, err := strconv.ParseInt(literal, 10, 32)
		if err != nil {
			t.Fatal(err)
		}
		return int32(v)
	case "boolean":
		return literal == "true"
	case "timestamp":
		v, err := time.Parse(time.RFC3339Nano, literal)
		if err != nil {
			t.Fatal(err)
		}
		return v
	case "date":
		return wire.MustDate(literal)
	case "uuid":
		return uuid.MustParse(literal)
	case "json":
		return jsontext.Value(literal)
	case "enum":
		return sampleStatus(literal)
	default:
		return literal
	}
}

func readWrite[T any](input string) (string, error) {
	var v T
	if err := wire.Unmarshal([]byte(input), &v); err != nil {
		return "", err
	}
	out, err := wire.Marshal(v)
	return string(out), err
}

// roundTrip lee un valor del cable con el tipo del diseño, como lo hará un DTO, y lo vuelve a escribir.
func roundTrip(typ, input string) (string, error) {
	switch typ {
	case "decimal":
		return readWrite[wire.Decimal](input)
	case "long":
		return readWrite[int64](input)
	case "int":
		return readWrite[int32](input)
	case "boolean":
		return readWrite[bool](input)
	case "timestamp":
		return readWrite[time.Time](input)
	case "date":
		return readWrite[wire.Date](input)
	case "uuid":
		return readWrite[uuid.UUID](input)
	case "json":
		return readWrite[jsontext.Value](input)
	case "enum":
		return readWrite[sampleStatus](input)
	default:
		return readWrite[string](input)
	}
}

func TestOutput(t *testing.T) {
	tests := []struct{ id, typ, value, want string }{
${WIRE_OUTPUT_CASES.map((entry) => caseLine({ id: entry.id, typ: entry.type, value: entry.value, want: entry.json })).join('\n')}
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			if got := marshal(t, typed(t, tt.typ, tt.value)); got != tt.want {
				t.Errorf("%s %s se escribe %s, quiero %s", tt.typ, tt.value, got, tt.want)
			}
		})
	}
}

func TestInputRoundTrip(t *testing.T) {
	tests := []struct{ id, typ, input, want string }{
${WIRE_INPUT_CASES.map((entry) => caseLine({ id: entry.id, typ: entry.type, input: entry.json, want: entry.roundTrip })).join('\n')}
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			got, err := roundTrip(tt.typ, tt.input)
			if err != nil || got != tt.want {
				t.Errorf("%s %s vuelve como %s (%v), quiero %s", tt.typ, tt.input, got, err, tt.want)
			}
		})
	}
}

func TestRejectedInput(t *testing.T) {
	tests := []struct{ id, typ, input string }{
${WIRE_REJECTED_INPUTS.map((entry) => caseLine({ id: entry.id, typ: entry.type, input: entry.json })).join('\n')}
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			if got, err := roundTrip(tt.typ, tt.input); err == nil {
				t.Errorf("%s %s se acepta como %s", tt.typ, tt.input, got)
			}
		})
	}
}

// sample es un DTO sin convenciones: un campo sin valor viaja como null.
type sample struct {
	A int64   \`json:"a"\`
	B *string \`json:"b"\`
}

// omitting es un DTO con conventions.nulls: omit, como lo escribe keel-go: omitzero en lo que puede no tener
// valor, y nunca en una lista.
type omitting struct {
	A     int64    \`json:"a"\`
	B     *string  \`json:"b,omitzero"\`
	Items []string \`json:"items"\`
}

func TestNullsIncludeByDefault(t *testing.T) {
	if got := marshal(t, sample{A: 1}); got != \`{"a":1,"b":null}\` {
		t.Errorf("got %s", got)
	}
}

func TestNullsOmitKeepsLists(t *testing.T) {
	if got := marshal(t, omitting{A: 1}); got != \`{"a":1,"items":[]}\` {
		t.Errorf("got %s", got)
	}
}

func TestListNeverNull(t *testing.T) {
	for _, input := range []string{\`{"a":1}\`, \`{"a":1,"items":null}\`} {
		var v omitting
		if err := wire.Unmarshal([]byte(input), &v); err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if got := marshal(t, v); got != \`{"a":1,"items":[]}\` {
			t.Errorf("%s vuelve como %s", input, got)
		}
	}
}

func TestUnknownIgnored(t *testing.T) {
	var v sample
	if err := wire.Unmarshal([]byte(\`{"a":1,"b":"x","otra":true}\`), &v); err != nil {
		t.Fatal(err)
	}
	if v.A != 1 || v.B == nil || *v.B != "x" {
		t.Errorf("got %+v", v)
	}
}

func TestNamesAreCaseSensitive(t *testing.T) {
	var v sample
	if err := wire.Unmarshal([]byte(\`{"A":7}\`), &v); err != nil {
		t.Fatal(err)
	}
	if v.A != 0 {
		t.Errorf("A se leyó de \\"A\\": %d", v.A)
	}
}

func TestDuplicateNameLastWins(t *testing.T) {
	var v sample
	if err := wire.Unmarshal([]byte(\`{"a":1,"a":2}\`), &v); err != nil {
		t.Fatal(err)
	}
	if v.A != 2 {
		t.Errorf("a = %d, quiero 2", v.A)
	}
}

func TestTrailingValueRejected(t *testing.T) {
	var v sample
	if err := wire.Unmarshal([]byte(\`{"a":1} {"a":2}\`), &v); err == nil {
		t.Error("un segundo valor tras el cuerpo se acepta")
	}
}

func TestEnumNotReadByNumber(t *testing.T) {
	if got, err := roundTrip("enum", "0"); err == nil {
		t.Errorf("un enum se lee de un número: %s", got)
	}
}

func TestDecimalReadsWrittenScale(t *testing.T) {
	tests := []struct{ input, want string }{
		{input: "2.50E1", want: "25.0"},
		{input: "1E+3", want: "1000"},
		{input: "1.0000000000000000000000000001", want: "1.0000000000000000000000000001"},
		{input: "1E-${MAX_DIGITS - 1}", want: "0.${'0'.repeat(MAX_DIGITS - 2)}1"},
		{input: "1E+${MAX_DIGITS - 1}", want: "1${'0'.repeat(MAX_DIGITS - 1)}"},
		{input: \`"+1.5"\`, want: "1.5"},
		{input: \`" 2.50 "\`, want: "2.50"},
		{input: \`".5"\`, want: "0.5"},
	}
	for _, tt := range tests {
		if got, err := roundTrip("decimal", tt.input); err != nil || got != tt.want {
			t.Errorf("%s vuelve como %s (%v), quiero %s", tt.input, got, err, tt.want)
		}
	}
}

func TestDecimalOutOfRangeRejected(t *testing.T) {
	for _, input := range []string{"1E-${MAX_DIGITS}", "1E+${MAX_DIGITS}", "100000E${MAX_DIGITS - 1}", \`"1e99999999999"\`, "true", "[]"} {
		if got, err := roundTrip("decimal", input); err == nil {
			t.Errorf("%s se acepta como %s", input, got)
		}
	}
}

func TestTimestampWithoutZoneRejected(t *testing.T) {
	for _, input := range []string{\`"2026-03-14T09:21:07.482"\`, \`"2026-03-14"\`, "1773480067482"} {
		if got, err := roundTrip("timestamp", input); err == nil {
			t.Errorf("%s se acepta como %s", input, got)
		}
	}
}

func TestIntegersOutOfRangeRejected(t *testing.T) {
	tests := []struct{ typ, input string }{
		{typ: "int", input: "2147483648"},
		{typ: "int", input: \`"2147483648"\`},
		{typ: "long", input: \`"9223372036854775808"\`},
		{typ: "long", input: "1.5"},
		{typ: "long", input: \`"1.5"\`},
	}
	for _, tt := range tests {
		if got, err := roundTrip(tt.typ, tt.input); err == nil {
			t.Errorf("%s %s se acepta como %s", tt.typ, tt.input, got)
		}
	}
}

// patch es un DTO de PATCH: cada campo distingue «no vino» de «vino a null».
type patch struct {
	Name  wire.Optional[string]    \`json:"name,omitzero"\`
	Count wire.Optional[int64]     \`json:"count,omitzero"\`
	At    wire.Optional[time.Time] \`json:"at,omitzero"\`
}

func TestOptionalKeepsThreeStates(t *testing.T) {
	var v patch
	input := \`{"name":null,"count":"9007199254740993","at":"2026-03-14T10:21:07.482+01:00"}\`
	if err := wire.Unmarshal([]byte(input), &v); err != nil {
		t.Fatal(err)
	}
	if !v.Name.Present() || !v.Name.IsNull() {
		t.Errorf("name tiene que venir a null: %+v", v.Name)
	}
	// El valor de dentro se lee con las reglas del contrato: el long desde una cadena y el instante a UTC.
	if count, ok := v.Count.Get(); !ok || count != 9007199254740993 {
		t.Errorf("count = %d, %t", count, ok)
	}
	want := \`{"name":null,"count":9007199254740993,"at":"2026-03-14T09:21:07.482Z"}\`
	if got := marshal(t, v); got != want {
		t.Errorf("got %s, quiero %s", got, want)
	}

	var absent patch
	if err := wire.Unmarshal([]byte(\`{}\`), &absent); err != nil {
		t.Fatal(err)
	}
	if absent.Name.Present() || absent.Count.Present() || absent.At.Present() {
		t.Errorf("un campo que no vino está presente: %+v", absent)
	}
	if got := marshal(t, absent); got != \`{}\` {
		t.Errorf("un PATCH vacío se escribe %s", got)
	}
}

func TestZeroDateIsNotWritten(t *testing.T) {
	if _, err := wire.Marshal(wire.Date{}); err == nil {
		t.Error("una fecha sin valor se escribe")
	}
	if _, err := wire.NewDate(2026, time.February, 29); err == nil {
		t.Error("el 29 de febrero de 2026 existe")
	}
	leap, err := wire.NewDate(2024, time.February, 29)
	if err != nil || leap.String() != "2024-02-29" {
		t.Errorf("2024-02-29: %v, %v", leap, err)
	}
}

`
  });
}

function decimalTestGo(model) {
  const { wire } = layout(model);
  const rounding = Object.entries(ROUNDING_TABLE.modes).flatMap(([mode, results]) =>
    ROUNDING_TABLE.inputs.map((input, index) => `\t\t{input: ${goString(input)}, mode: wire.${mode}, want: ${goString(results[index])}},`)
  );
  return packageFile(model, wire, {
    test: true,
    imports: ['errors', 'testing', 'internal/platform/wire'],
    body: `
func dec(text string) wire.Decimal {
	return wire.MustDecimal(text)
}

func TestDecimalArithmeticKeepsScale(t *testing.T) {
	tests := []struct {
		name string
		got  wire.Decimal
		want string
	}{
		{name: "la suma toma la mayor escala", got: dec("2.50").Add(dec("1.5")), want: "4.00"},
		{name: "la resta toma la mayor escala", got: dec("1.5").Sub(dec("2.50")), want: "-1.00"},
		{name: "el producto suma las escalas", got: dec("2.50").Mul(dec("1.5")), want: "3.750"},
		{name: "el opuesto conserva la escala", got: dec("0.50").Neg(), want: "-0.50"},
		{name: "el valor absoluto conserva la escala", got: dec("-0.50").Abs(), want: "0.50"},
		{name: "el valor cero es 0", got: wire.Decimal{}, want: "0"},
		{name: "el valor cero suma", got: wire.Decimal{}.Add(dec("2.50")), want: "2.50"},
		{name: "NewDecimal con escala", got: wire.NewDecimal(250, 2), want: "2.50"},
		{name: "NewDecimal con escala negativa", got: wire.NewDecimal(5, -2), want: "500"},
		{name: "ganar decimales", got: dec("2.5").Rescale(3, wire.RoundHalfUp), want: "2.500"},
		{name: "perder decimales", got: dec("2.345").Rescale(2, wire.RoundHalfUp), want: "2.35"},
		{name: "escala negativa", got: dec("125").Rescale(-1, wire.RoundHalfUp), want: "130"},
		{name: "un negativo que redondea a cero", got: dec("-0.001").Rescale(2, wire.RoundHalfUp), want: "0.00"},
	}
	for _, tt := range tests {
		if got := tt.got.String(); got != tt.want {
			t.Errorf("%s: %s, quiero %s", tt.name, got, tt.want)
		}
	}
}

func TestDecimalCmpComparesQuantity(t *testing.T) {
	if dec("2.5").Cmp(dec("2.50")) != 0 || dec("2.5").String() == dec("2.50").String() {
		t.Error("2.5 y 2.50 son la misma cantidad con distinta escala")
	}
	if dec("-1").Cmp(dec("0.001")) != -1 || dec("10").Cmp(dec("9.99")) != 1 {
		t.Error("el orden de las cantidades")
	}
	if dec("0.00").Sign() != 0 || dec("-0.01").Sign() != -1 {
		t.Error("el signo")
	}
}

// La tabla de la documentación de java.math.RoundingMode: el diseño habla el vocabulario de BigDecimal.
func TestRoundingModesMatchJava(t *testing.T) {
	tests := []struct {
		input string
		mode  wire.RoundingMode
		want  string
	}{
${rounding.join('\n')}
	}
	for _, tt := range tests {
		if got := dec(tt.input).Rescale(0, tt.mode).String(); got != tt.want {
			t.Errorf("%s con el modo %d: %s, quiero %s", tt.input, tt.mode, got, tt.want)
		}
	}
}

func TestDecimalQuo(t *testing.T) {
	tests := []struct {
		a, b  string
		scale int32
		mode  wire.RoundingMode
		want  string
	}{
		{a: "1", b: "3", scale: 4, mode: wire.RoundHalfUp, want: "0.3333"},
		{a: "2", b: "3", scale: 4, mode: wire.RoundHalfUp, want: "0.6667"},
		{a: "-2", b: "3", scale: 4, mode: wire.RoundHalfUp, want: "-0.6667"},
		{a: "10", b: "4", scale: 0, mode: wire.RoundHalfEven, want: "2"},
		{a: "10.00", b: "0.4", scale: 2, mode: wire.RoundDown, want: "25.00"},
		{a: "1", b: "8", scale: 1, mode: wire.RoundHalfEven, want: "0.1"},
	}
	for _, tt := range tests {
		got, err := dec(tt.a).Quo(dec(tt.b), tt.scale, tt.mode)
		if err != nil || got.String() != tt.want {
			t.Errorf("%s / %s: %s (%v), quiero %s", tt.a, tt.b, got, err, tt.want)
		}
	}
	if _, err := dec("1").Quo(dec("0.00"), 2, wire.RoundHalfUp); !errors.Is(err, wire.ErrDivisionByZero) {
		t.Errorf("dividir por cero: %v", err)
	}
}

func TestDecimalIsImmutable(t *testing.T) {
	a := dec("2.50")
	b := a
	_ = a.Add(dec("1")).Neg().Mul(dec("3"))
	if a.String() != "2.50" || b.String() != "2.50" {
		t.Errorf("una operación modificó el operando: %s, %s", a, b)
	}
}
`
  });
}

function fuzzTestGo(model) {
  const { wire } = layout(model);
  const all = [...WIRE_OUTPUT_CASES.map((entry) => ({ type: entry.type, text: entry.value })), ...[...WIRE_INPUT_CASES, ...WIRE_REJECTED_INPUTS].map((entry) => ({ type: entry.type, text: unquoted(entry.json) }))];
  const seeds = (type) => [...new Set(all.filter((entry) => entry.type === type).map((entry) => entry.text))].map((text) => `\t\t${goString(text)},`).join('\n');
  return packageFile(model, wire, {
    test: true,
    imports: ['testing', 'internal/platform/wire'],
    body: `
// Las pruebas de fuzzing de los lectores del cable. Con go test solo corren las semillas, que son los casos de
// keel-core/gen/wire.js; con go test -fuzz=FuzzX buscan una entrada que rompa la ida y vuelta.

func FuzzParseDecimal(f *testing.F) {
	for _, seed := range []string{
${seeds('decimal')}
		// Lo que encontró el fuzzing la primera vez: se aceptaba y su forma plana ya no se podía volver a leer.
		"100000E1000",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, text string) {
		d, err := wire.ParseDecimal(text)
		if err != nil {
			return
		}
		again, err := wire.ParseDecimal(d.String())
		if err != nil || again.String() != d.String() || again.Scale() != d.Scale() {
			t.Fatalf("%q se lee como %s y vuelve como %s (%v)", text, d, again, err)
		}
	})
}

func FuzzParseTimestamp(f *testing.F) {
	for _, seed := range []string{
${seeds('timestamp')}
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, text string) {
		ts, err := wire.ParseTimestamp(text)
		if err != nil {
			return
		}
		again, err := wire.ParseTimestamp(wire.FormatTimestamp(ts))
		if err != nil || !again.Equal(ts) {
			t.Fatalf("%q se lee como %v y vuelve como %v (%v)", text, ts, again, err)
		}
	})
}

func FuzzParseDate(f *testing.F) {
	for _, seed := range []string{
${seeds('date')}
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, text string) {
		d, err := wire.ParseDate(text)
		if err != nil {
			return
		}
		if d.String() != text {
			t.Fatalf("%q se lee como %s", text, d)
		}
	})
}
`
  });
}

/** El contenido de una cadena JSON, o el texto tal cual si es otro valor. */
function unquoted(json) {
  return json.startsWith('"') ? JSON.parse(json) : json;
}
