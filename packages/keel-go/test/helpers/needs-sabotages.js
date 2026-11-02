// Los sabotajes de lo que `needs` y OAuth2 añaden a los clientes (tramo 13h): cada uno rompe UN mecanismo en el Go emitido para
// catalog-extended, conservando que compile, y dice qué prueba de clients_test.go tiene que caer. Se aplican en memoria,
// antes de escribir lo emitido, y `go-check` los ejecuta; test/needs-sabotages.test.js comprueba sin Go que siguen aplicándose.

export const NEEDS_SUBJECT = 'catalog-extended';

const CLIENTS = 'internal/infrastructure/clients';

export const NEEDS_SABOTAGES = {
  // La ventana no se mira: se sirve un valor de cualquier edad, la caché sin expiración que el diseño prohíbe.
  'lastknown-window': {
    file: `${CLIENTS}/last_known.go`,
    from: 'if v.now().Sub(entry.storedAt) > maxAge {',
    to: 'if v.now().Sub(entry.storedAt) > maxAge+24*time.Hour {',
    expect: /^(TestElAlmacenRecuerdaDentroDeLaVentanaYOlvidaFueraDeElla|Test\w+SirveElUltimoValorConocidoDentroDeSuVentanaYDespuesSeRinde)$/
  },
  // La clave no mira los parámetros: el último valor de OTRO producto.
  'lastknown-key': {
    file: `${CLIENTS}/last_known.go`,
    from: 'return strings.Join(texts, "\\x1f")',
    to: 'return strings.Join(texts[:0], "\\x1f")',
    // Con todo bajo la misma clave, el tope tampoco ve entradas que tirar.
    expect: /^(TestLaClaveDistingueLlamadaYParametros|TestElTopeTiraLoMasViejo)$/
  },
  // El valor rescatado no se marca: quien lo expone lo cachearía como uno recién leído.
  'lastknown-stale': {
    file: `${CLIENTS}/pricing_fallback.go`,
    from: 'remembered.Stale = true',
    to: 'remembered.Stale = false',
    expect: /^Test\w+SirveElUltimoValorConocidoDentroDeSuVentanaYDespuesSeRinde$/
  },
  // El tope no tira nada: la fuga lenta.
  'lastknown-cap': {
    file: `${CLIENTS}/last_known.go`,
    from: 'if len(v.entries) >= maxLastKnownEntries {',
    to: 'if len(v.entries) >= maxLastKnownEntries*2 {',
    expect: /^TestElTopeTiraLoMasViejo$/
  },
  // El token no se reutiliza: una petición al emisor por llamada.
  'oauth-reuse': {
    file: `${CLIENTS}/client_credentials.go`,
    from: 'if c.header != "" && c.now().Before(c.renewAt) {',
    to: 'if c.header == "-" && c.now().Before(c.renewAt) {',
    expect: /^(TestLaConcesionPideUnTokenYLoReutilizaConLaCabeceraBasicYElFormularioDeSpring|TestDosLlamadasALaVezSonUnaSolaPeticionAlEmisor|TestElTokenSeRenuevaSesentaSegundosAntesDeCaducarYSinExpiresInDuraUnSegundo)$/
  },
  // Sin el margen de Spring: el token puede caducar en vuelo.
  'oauth-skew': {
    file: `${CLIENTS}/client_credentials.go`,
    from: 'c.renewAt = c.now().Add(lifetime - clockSkew)',
    to: 'c.renewAt = c.now().Add(lifetime)',
    expect: /^TestElTokenSeRenuevaSesentaSegundosAntesDeCaducarYSinExpiresInDuraUnSegundo$/
  },
  // Un token que no es Bearer se acepta.
  'oauth-bearer': {
    file: `${CLIENTS}/client_credentials.go`,
    from: 'if kind, ok := fields["token_type"].(string); !ok || !strings.EqualFold(kind, "bearer") {',
    to: 'if kind, ok := fields["token_type"].(string); ok && strings.EqualFold(kind, "-") {',
    expect: /^TestUnEmisorCaidoORechazandoOSinTokenBearerEsAuthGrant$/
  },
  // El secreto va con la codificación de net/url, no con la de URLEncoder.
  'oauth-encode': {
    file: `${CLIENTS}/client_credentials.go`,
    from: "b == '.', b == '-', b == '*', b == '_':",
    to: "b == '.', b == '-', b == '~', b == '_':",
    expect: /^TestFormEncodeEsElDeURLEncoder$/
  },
  // La petición sale sin el token.
  'oauth-header': {
    file: `${CLIENTS}/exchange.go`,
    from: 'outgoing.Header.Set("Authorization", authorization)',
    to: 'outgoing.Header.Set("X-Authorization", authorization)',
    expect: /^TestConTokenLaPeticionLlevaElBearerYSinElNoSale$/
  }
};

export function applyNeedsSabotage(sabotage, files) {
  const target = files.find((file) => file.path === sabotage.file);
  if (!target || !target.content.includes(sabotage.from)) throw new Error(`el sabotaje de ${sabotage.file} ya no encuentra «${sabotage.from}»`);
  return files.map((file) => (file === target ? { ...file, content: file.content.replace(sabotage.from, () => sabotage.to) } : file));
}
