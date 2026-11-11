// Los sabotajes de token-check: rompen lo emitido conservando la forma (todo compila), y cada uno tiene que caer en
// exactamente los casos marcados con sus defectos (`defect`, keel-core/gen/token-cases.js), más `methods` si mide algo
// que no es un caso del token. Cada edición es `[clase, texto o expresión, sustituto]`.

export const TOKEN_SABOTAGES = {
  'token-use': { defects: ['D1'], edits: [['JwtAuthConverter', 'if (!"access".equals(', 'if (false && !"access".equals(']] },
  'scope-prefix': {
    defects: ['D2'],
    edits: [
      [
        'JwtAuthConverter',
        /\.filter\(scope -> scope\.startsWith\(resourceServer \+ "\/"\)[^\n]*\n\s*\.map\(scope -> scope\.substring\(resourceServer\.length\(\) \+ 1\)\)/,
        ".map(scope -> scope.substring(scope.indexOf('/') + 1))"
      ]
    ]
  },
  'client-translation': {
    defects: ['D3', 'D4'],
    edits: [
      ['ServiceClientIds', 'return ids.get(declaredName);', 'return declaredName;'],
      ['ServiceClientIds', /return ids\.entrySet\(\)[^\n]*\n/, 'return clientId;\n']
    ]
  },
  // P2: un id que falta deja de impedir el arranque.
  'client-id-required': {
    defects: [],
    methods: ['clientIdIsRequired'],
    edits: [['ServiceClientIds', 'environment.getRequiredProperty("security.client-ids." + client)', 'environment.getProperty("security.client-ids." + client, "")']]
  }
};
