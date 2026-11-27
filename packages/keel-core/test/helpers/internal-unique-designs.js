// Los diseños DERIVADOS con una hija que lleva una clave única GLOBAL (gen/internal-unique.js), en los dos modelos: ninguna
// fixture la tiene (la forma salió de la corrida payment-dotnet del 2026-11-27, `Refund.refundRequestId`). La variable de
// una plantilla gana un `code` único en todas las plantillas. Los comparten los cuatro generadores: keel-dotnet y keel-go
// los recorren como variantes (UNCOVERED_BRANCHES) y keel-spring y keel-nest como diseños de sus pruebas.

function withVariableCode(layers) {
  layers.domain.entities.TemplateVariable.fields.code = {
    type: 'string',
    unique: true,
    constraints: { maxLength: 64 },
    description: 'Código de la variable, único en todas las plantillas.'
  };
}

export const INTERNAL_UNIQUE_DESIGNS = [
  { name: 'mailer-child-unique', from: 'notification-mailer', root: 'Template', child: 'TemplateVariable', field: 'code', mutate: withVariableCode },
  { name: 'mailer-mongo-child-unique', from: 'notification-mailer-mongo', root: 'Template', child: 'TemplateVariable', field: 'code', mutate: withVariableCode }
];
