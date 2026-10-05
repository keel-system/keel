// Los identificadores que genera el servidor: UUID versión 7, no la 4 de `UUID.randomUUID()`.
//
// La PK de toda raíz es un UUID que asigna la aplicación, y con la versión 4 —aleatoria— cada
// inserción cae en un punto cualquiera del índice. En los motores que guardan la tabla ORDENADA por
// su PK (InnoDB en MySQL y MariaDB, el índice clúster de SQL Server) eso reordena la tabla entera
// con cada alta: páginas partidas, índice fragmentado y una caché que no sirve para lo reciente. En
// PostgreSQL y Oracle el coste es menor pero el mismo en forma: lo recién insertado queda disperso.
// La versión 7 lleva delante los milisegundos, así que cada id nuevo va al FINAL del índice.
//
// Medido el 2026-10-05 (50 ids insertados desordenados, `ORDER BY id`): PostgreSQL (`uuid`), MySQL
// (`binary(16)` con `UUID_TO_BIN` sin intercambio, el literal del catálogo) y MariaDB 11 (`uuid`
// nativo, que reordena bytes de los v1 pero no de los v7) devuelven el orden temporal; con v4 de
// control, no. SQL Server ordena `uniqueidentifier` por sus últimos 6 bytes, así que allí v7 no
// gana nada —tampoco pierde—; SQL Server y Oracle, sin medir.
//
// Es Java puro (`SecureRandom` y el reloj) y vive en el dominio, que es donde nacen las raíces: no
// hay dependencia que añadir ni puerto que inyectar. El contrato no cambia: sigue siendo un UUID.

import { javaFile, javaPath, subPackage } from './render.js';
import { UUID_V7_CALL } from '../lib/model.js';

export const IDS_PKG = 'domain.identity';
export const IDS_CLASS = 'Uuids';

export function generate(model) {
  if ((model.entities ?? []).length === 0) return [];
  return [renderUuids(model)];
}

/** El import del helper, para quien lo llama. */
export function uuidsImport(model) {
  return `${subPackage(model, IDS_PKG)}.${IDS_CLASS}`;
}

/** ¿Usa este inicializador el helper? (`fieldInitializer` de model.js lo emite para un uuid generado). */
export function usesUuids(initializer) {
  return typeof initializer === 'string' && initializer.includes(UUID_V7_CALL);
}

function renderUuids(model) {
  const body = `/**
 * Identificadores UUID versión 7 (RFC 9562): 48 bits de milisegundos delante, versión, y 74 bits
 * aleatorios.
 *
 * <p>Es la forma de crear el id de una raíz nueva, en vez de {@code UUID.randomUUID()} (versión 4,
 * aleatoria). Con la 4, cada alta cae en un punto cualquiera del índice de la PK, y en los motores
 * que guardan la tabla ordenada por ella (MySQL, MariaDB) eso reordena la tabla con cada inserción.
 * Con la 7 cada id nuevo va al final. SQL Server ordena el uniqueidentifier por sus últimos bytes:
 * allí no gana nada, ni pierde. El contrato no cambia: sigue siendo un UUID.
 *
 * <p>Dentro del mismo milisegundo el orden lo decide la parte aleatoria, así que dos ids del mismo
 * milisegundo no salen necesariamente en orden de creación: lo que se gana es localidad, no un
 * contador. Y el id deja ver el instante en que se creó; si eso fuera un dato sensible para algún
 * recurso, su id no debe salir de aquí.
 */
public final class ${IDS_CLASS} {

    private static final SecureRandom RANDOM = new SecureRandom();

    private ${IDS_CLASS}() {
    }

    /** Un UUID versión 7 nuevo. */
    public static UUID v7() {
        long millis = System.currentTimeMillis();
        byte[] random = new byte[10];
        RANDOM.nextBytes(random);
        // 48 bits de tiempo | versión 7 | 12 bits aleatorios.
        long msb = (millis << 16) | 0x7000L | ((random[0] & 0x0FL) << 8) | (random[1] & 0xFFL);
        // Variante 10 | 62 bits aleatorios.
        long lsb = 0x8000000000000000L | ((random[2] & 0x3FL) << 56);
        for (int i = 3; i < 10; i++) {
            lsb |= (random[i] & 0xFFL) << (8 * (9 - i));
        }
        return new UUID(msb, lsb);
    }
}`;

  return {
    path: javaPath(model, IDS_PKG, IDS_CLASS),
    content: javaFile(subPackage(model, IDS_PKG), ['java.security.SecureRandom', 'java.util.UUID'], body)
  };
}
