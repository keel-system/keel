// Los diseños DERIVADOS con un índice único CONDICIONADO sobre una HIJA del agregado («como mucho una variable principal
// por plantilla»): ninguna fixture lo tiene —el de notification-mailer está sobre la raíz Template—. La forma salió de la
// corrida payment-nest del 2026-11-27 (`PaymentMethod.isDefault` en el Wallet): el agregado se guarda con UN save en
// cascada, así que el handler no puede ordenar las escrituras de sus hijas y el relevo lo tiene que hacer el adaptador.
// Solo relacional: en el documento el agregado es una sola escritura.

function withPrimaryVariable(layers) {
  const variable = layers.domain.entities.TemplateVariable;
  variable.fields.isPrimary = { type: 'boolean', default: false, description: 'La variable principal de la plantilla: como mucho una.' };
  variable.relations = {
    ...(variable.relations ?? {}),
    template: { entity: 'Template', cardinality: 'many-to-one', required: true, description: 'La plantilla que la declara.' }
  };
  layers.persistence.entities.TemplateVariable = {
    ...(layers.persistence.entities.TemplateVariable ?? {}),
    persisted: true,
    indexes: [
      {
        fields: ['template'],
        unique: true,
        when: { field: 'isPrimary', equals: true },
        error: 'CONCURRENT_MODIFICATION',
        description: 'Como mucho una variable principal por plantilla.'
      }
    ]
  };
}

export const CHILD_CONDITIONAL_DESIGNS = [
  { name: 'mailer-child-conditional', from: 'notification-mailer', root: 'Template', child: 'TemplateVariable', collection: 'variables', field: 'isPrimary', mutate: withPrimaryVariable }
];
