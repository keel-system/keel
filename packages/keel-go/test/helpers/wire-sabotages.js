// Los sabotajes del contrato del cable: cada uno rompe UNA regla en el Go emitido conservando que compile, y
// nombra la prueba emitida que tiene que salir en rojo. Los ejecuta go-check (`go test` sobre el paquete
// saboteado) y test/wire.test.js comprueba sin Go que cada uno se sigue aplicando al texto de hoy: un sabotaje
// que ya no encuentra lo que buscaba no falsa nada.

const WIRE = 'internal/platform/wire';

export const WIRE_SABOTAGES = [
  {
    id: 'decimal-scale',
    what: 'el decimal pierde los ceros de la escala (2.50 sale 2.5)',
    file: `${WIRE}/decimal.go`,
    find: '\treturn sign + digits[:cut] + "." + digits[cut:]\n',
    replace: '\treturn strings.TrimSuffix(strings.TrimRight(sign+digits[:cut]+"."+digits[cut:], "0"), ".")\n',
    fails: 'TestOutput/decimal-keeps-scale'
  },
  {
    id: 'timestamp-format',
    what: 'el instante sale con la precisión y la zona que lleve',
    file: `${WIRE}/wire.go`,
    find: 'return t.UTC().Truncate(time.Millisecond).Format(TimestampLayout)',
    replace: 'return t.Format(time.RFC3339Nano)',
    fails: 'TestOutput/timestamp-pads'
  },
  {
    id: 'optional-tri-state',
    what: 'un campo de PATCH a null se lee como ausente',
    file: `${WIRE}/optional.go`,
    find: '\t\t*o = Null[T]()\n',
    replace: '\t\t*o = Optional[T]{}\n',
    fails: 'TestOptionalKeepsThreeStates'
  },
  {
    id: 'list-null',
    what: 'una lista sin elementos sale null',
    file: `${WIRE}/wire.go`,
    find: '\tjsontext.AllowDuplicateNames(true),\n',
    replace: '\tjsontext.AllowDuplicateNames(true),\n\tjson.FormatNilSliceAsNull(true),\n',
    fails: 'TestListNeverNull'
  },
  {
    id: 'long-from-string',
    what: 'un long no se lee de una cadena numérica',
    file: `${WIRE}/wire.go`,
    find: '\t\tjson.UnmarshalFromFunc(unmarshalInt64),\n',
    replace: '',
    fails: 'TestInputRoundTrip/long-from-string'
  },
  {
    id: 'case-insensitive',
    what: 'los nombres del cuerpo se casan sin distinguir mayúsculas (lo que hacía encoding/json v1)',
    file: `${WIRE}/wire.go`,
    find: '\tjsontext.AllowDuplicateNames(true),\n',
    replace: '\tjsontext.AllowDuplicateNames(true),\n\tjson.MatchCaseInsensitiveNames(true),\n',
    fails: 'TestNamesAreCaseSensitive'
  }
];

/** El texto saboteado, o null si el sabotaje ya no se aplica. */
export function applySabotage(sabotage, content) {
  if (!content.includes(sabotage.find)) return null;
  return content.replace(sabotage.find, sabotage.replace);
}
