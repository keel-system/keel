// Una proyección que no es ningún lenguaje: cumple el contrato de keel-core/gen/projection.js con referencias de
// tipo opacas (`ref:<nombre>`), sin tipos, imports ni anotaciones. Con ella se construye el modelo neutral en las
// pruebas de keel-core (gen-model.test.js la usa para afirmar que el modelo no escribe Java por su cuenta).

const nameOf = (resolved) => resolved.name ?? resolved.base;
export const PROBE = {
  projectSuffix: 'probe',
  service: () => ({ module: 'probe' }),
  parameterType: (type) => ({ typeRef: `ref:${type}` }),
  fieldType: (resolved, { list = false } = {}) => ({ typeRef: `ref:${nameOf(resolved)}${list ? '[]' : ''}` }),
  elementType: (resolved) => ({ elementRef: `ref:${nameOf(resolved)}` }),
  namedType: (name, { list = false } = {}) => ({ typeRef: `ref:${name}${list ? '[]' : ''}` }),
  namedElement: (name) => ({ elementRef: `ref:${name}` }),
  renamed: (name) => ({ typeRef: `ref:${name}`, elementRef: `ref:${name}` }),
  typeNameOf: (field) => field?.typeRef?.replace(/^ref:/, ''),
  carryType: (field) => ({ typeRef: field.typeRef }),
  uploadType: () => ({ typeRef: 'ref:upload', elementRef: 'ref:upload' }),
  uploadValidation: (required) => ({ validation: required ? ['required'] : [], inputValidation: required ? ['required'] : [] }),
  replicaKey: (keyField) => ({ keyRef: keyField?.typeRef ?? 'ref:uuid' }),
  errorBase: (http) => `error-${http}`,
  fieldDetails: () => ({ validation: [], numeric: null, inputValidation: [], inheritedPattern: null, columns: [], elementColumns: [], initializer: null }),
  messages: {
    lockVersionReserved: (entity) => `lockVersion reservado en ${entity}`,
    readQueriesRef: (kind) => `lecturas-${kind}`,
    pathParamFallback: (op, route, name) => `${op}: ${route} sin ${name}`,
    cognitoEmulated: () => 'cognito emulado'
  }
};
