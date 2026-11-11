// Los diseños de las redes del contrato del token (fase 2 de PLAN-PROVEEDOR-IDENTIDAD.md) que ninguna fixture cubre,
// como parche sobre una fixture. Los ejecutan las cuatro redes, para que midan lo mismo.

export const IDENTITY_DESIGNS = [
  // La identidad del cliente máquina con correspondencia 1:1: sin `resolvedBy`, el identificador del recurso es el nombre
  // que declara el diseño, y un proveedor que genera el id obliga a traducirlo (D4).
  {
    name: 'mailer-one-to-one',
    from: 'notification-mailer',
    mutate(layers) {
      delete layers.security.authentication.callerIdentity.from.resolvedBy;
    }
  }
];
