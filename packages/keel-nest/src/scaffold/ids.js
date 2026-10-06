// Los identificadores que genera el servidor: UUID versión 7, igual que keel-spring (`Uuids.v7()`).
//
// La PK de toda raíz es un UUID que asigna la aplicación. Con la versión 4 —aleatoria— cada alta
// cae en un punto cualquiera del índice, y en los motores que guardan la tabla ORDENADA por su PK
// (InnoDB en MySQL y MariaDB) eso reordena la tabla con cada inserción. La versión 7 lleva delante
// los milisegundos, así que cada id nuevo va al FINAL del índice. El razonamiento y la medición
// están en keel-spring/src/scaffold/ids.js; aquí solo cambia el lenguaje.
//
// Vive en el dominio, que es donde nacen las raíces, y solo usa `node:crypto`: no es un framework,
// así que la frontera hexagonal lo admite.

import { DIRS, classPath, tsModule } from './render.js';
import { UUID_V7_CALL } from '../lib/ts-projection.js';

export const UUIDS_CLASS = 'Uuids';
export const UUIDS_TS = classPath(DIRS.identity, UUIDS_CLASS);

export function generate(model) {
  if ((model.entities ?? []).length === 0) return [];
  return [
    { path: UUIDS_TS, content: tsModule(UUIDS_TS, [{ symbol: 'randomBytes', from: 'node:crypto' }], uuidsBody()) },
    { path: 'test/domain/uuids.test.ts', content: uuidsTest() }
  ];
}

/** ¿Usa este inicializador el helper? */
export function usesUuids(initializer) {
  return typeof initializer === 'string' && initializer.includes(UUID_V7_CALL);
}

function uuidsBody() {
  return `/**
 * Identificadores UUID versión 7 (RFC 9562): 48 bits de milisegundos delante, versión, variante y
 * 74 bits aleatorios.
 *
 * Es la forma de crear el id de una raíz nueva, en vez de \`randomUUID()\` (versión 4, aleatoria):
 * con la 4 cada alta cae en un punto cualquiera del índice de la PK, con la 7 va al final. El
 * contrato no cambia: sigue siendo un UUID.
 *
 * Dentro del mismo milisegundo el orden lo decide la parte aleatoria: lo que se gana es localidad,
 * no un contador. Y el id deja ver el instante en que se creó; si eso fuera sensible para algún
 * recurso, su id no debe salir de aquí.
 */
export class ${UUIDS_CLASS} {
  private constructor() {}

  /** Un UUID versión 7 nuevo, en su forma canónica de 36 caracteres. */
  static v7(): string {
    const bytes = randomBytes(16);
    const millis = BigInt(Date.now());
    for (let i = 0; i < 6; i++) {
      bytes[i] = Number((millis >> BigInt(8 * (5 - i))) & 0xffn);
    }
    // Versión 7 en el nibble alto del byte 6; variante 10 en los dos bits altos del byte 8.
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return \`\${hex.slice(0, 8)}-\${hex.slice(8, 12)}-\${hex.slice(12, 16)}-\${hex.slice(16, 20)}-\${hex.slice(20)}\`;
  }
}`;
}

function uuidsTest() {
  return `import { describe, expect, it } from 'vitest';
import { Uuids } from '../../src/domain/identity/uuids.js';

// La forma del id es contrato (un UUID) y el orden temporal es la razón de que sea la versión 7.
describe('Uuids.v7', () => {
  it('es un UUID de versión 7 con la variante RFC 9562', () => {
    expect(Uuids.v7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('lleva delante los milisegundos de su creación', () => {
    const before = Date.now();
    const id = Uuids.v7();
    const millis = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(millis).toBeGreaterThanOrEqual(before);
    expect(millis).toBeLessThanOrEqual(Date.now());
  });

  it('dos ids de milisegundos distintos se ordenan como se crearon', async () => {
    const first = Uuids.v7();
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(Uuids.v7() > first).toBe(true);
  });
});
`;
}
