// La jerarquía de errores del dominio que comparten los servidores generados: una clase base por status HTTP,
// de la que extiende el error de cada `code` declarado. Los nombres son parte de la arquitectura compartida, no
// de un framework (el dominio no importa el de ninguno), y el manejador de errores de la API responde con el
// status de la base. Estaba escrita cuatro veces —la proyección y el emisor de excepciones de keel-spring y de
// keel-nest— (incremento 1d de PLAN-KEEL-DOTNET.md).

/** Las clases base, en el orden en que se emiten, con el status al que responde cada una. */
export const ERROR_BASES = [
  { name: 'BadRequestException', http: 400 },
  { name: 'UnauthorizedException', http: 401 },
  { name: 'ForbiddenException', http: 403 },
  { name: 'NotFoundException', http: 404 },
  { name: 'ConflictException', http: 409 },
  { name: 'PayloadTooLargeException', http: 413 },
  { name: 'BusinessException', http: 422 }
];

/** La raíz de la jerarquía: el error de un status sin clase base propia extiende de ella. */
export const DOMAIN_EXCEPTION = 'DomainException';

/** La clase base del error de un `code` que responde con `http`. */
export function errorBaseFor(http) {
  return ERROR_BASES.find((base) => base.http === http)?.name ?? DOMAIN_EXCEPTION;
}
