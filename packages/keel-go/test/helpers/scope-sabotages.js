// Los sabotajes del alcance por recurso (tramo 13h-b): cada uno rompe UN mecanismo en el Go emitido para asset-vault, conservando
// que compile, y dice qué prueba de caller_scope_test.go tiene que caer. Se aplican en memoria, antes de escribir lo emitido, y
// `go-check` los ejecuta; test/caller-scope.test.js comprueba sin Go que siguen aplicándose.

export const SCOPE_SUBJECT = 'asset-vault';

const ADAPTER = 'internal/platform/security/caller_scope.go';

export const SCOPE_SABOTAGES = {
  // El claim solo se lee como lista: un proveedor que lo manda como texto deja a todos fuera del alcance.
  'scope-text': {
    file: ADAPTER,
    from: 'return strings.FieldsFunc(text, func(r rune) bool { return strings.ContainsRune(", \\t\\n\\r", r) })',
    to: 'return strings.FieldsFunc("", func(r rune) bool { return strings.ContainsRune(", \\t\\n\\r", r) && text == "" })',
    expect: /^TestElClaimDelAlcanceSeLeeComoListaOComoTexto$/
  },
  // El vacío del claim se conserva: un recurso sin valor quedaría en el alcance.
  'scope-empty': {
    file: ADAPTER,
    from: 'return slices.DeleteFunc(values, func(value string) bool { return value == "" })',
    to: 'return slices.DeleteFunc(values, func(value string) bool { return value == "-" })',
    expect: /^(TestElClaimDelAlcanceSeLeeComoListaOComoTexto|TestElAlcanceCubreSoloLoQueEnumeraYDistingueMayusculas)$/
  },
  // Sin distinguir mayúsculas: el diseño compara el claim tal cual.
  'scope-fold': {
    file: ADAPTER,
    from: 'return scope.IsExempt(ctx) || slices.Contains(scope.ScopedValues(ctx), value)',
    to: 'return scope.IsExempt(ctx) || slices.ContainsFunc(scope.ScopedValues(ctx), func(v string) bool { return strings.EqualFold(v, value) })',
    expect: /^TestElAlcanceCubreSoloLoQueEnumeraYDistingueMayusculas$/
  },
  // La exención del rol no se mira: el administrador recibe el 403 en todo lo que no enumere.
  'scope-role': {
    file: ADAPTER,
    from: 'return slices.ContainsFunc(exemptAuthorities, principal.Has) || slices.Contains(exemptClients, credentialClient(principal))',
    to: 'return slices.Contains(exemptClients, credentialClient(principal))',
    expect: /^TestUnRolExentoAlcanzaCualquierRecurso$/
  },
  // El nombre del principal manda sobre azp: un usuario llamado como el cliente se exime por llamarse así.
  'scope-client': {
    file: ADAPTER,
    from: 'for _, name := range []string{"azp", "client_id"} {',
    to: 'if slices.Contains(exemptClients, principal.Name) {\n\t\treturn principal.Name\n\t}\n\tfor _, name := range []string{"azp", "client_id"} {',
    expect: /^TestUnClienteExentoSeReconocePorLaCredencial$/
  }
};

/** Los archivos con el sabotaje aplicado (una copia: el plan no se toca). */
export function applyScopeSabotage(sabotage, files) {
  return files.map((file) => (file.path === sabotage.file ? { ...file, content: file.content.replace(sabotage.from, sabotage.to) } : file));
}
