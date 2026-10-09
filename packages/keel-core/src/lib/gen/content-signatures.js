// La FIRMA de un binario por tipo MIME: los primeros bytes que identifican el formato. Con ella, los
// `allowedContentTypes` de un bucket comprueban el contenido y no solo la palabra del cliente —el
// `Content-Type` de una parte multipart lo elige quien sube—.
//
// Es la tabla del `ContentSignature` que emite keel-spring, como DATOS: keel-nest la emite desde aquí y
// un test de paridad exige que la de keel-spring nombre los mismos tipos. Un MIME que no está aquí (texto,
// SVG, CSV, JSON) no tiene firma que comprobar y SE ACEPTA: prometer otra cosa sería peor que no prometer.
//
// Cada tipo tiene una lista de ALTERNATIVAS (un GIF vale con GIF87a o con GIF89a); dentro de una
// alternativa, TODOS los trozos tienen que casar (un WebP es RIFF al principio y WEBP en el byte 8).

const ascii = (text) => [...text].map((char) => char.charCodeAt(0));

export const CONTENT_SIGNATURES = {
  'image/jpeg': [[{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
  'image/png': [[{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }]],
  'image/gif': [[{ offset: 0, bytes: ascii('GIF87a') }], [{ offset: 0, bytes: ascii('GIF89a') }]],
  'image/webp': [
    [
      { offset: 0, bytes: ascii('RIFF') },
      { offset: 8, bytes: ascii('WEBP') }
    ]
  ],
  'image/bmp': [[{ offset: 0, bytes: ascii('BM') }]],
  'image/tiff': [[{ offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] }], [{ offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] }]],
  'application/pdf': [[{ offset: 0, bytes: ascii('%PDF-') }]]
};

/** ¿El contenido casa con el tipo declarado? La referencia ejecutable: la misma regla que emiten los dos generadores. */
export function contentMatches(content, declaredContentType) {
  if (declaredContentType == null) return true;
  const alternatives = CONTENT_SIGNATURES[declaredContentType.toLowerCase()];
  if (!alternatives) return true;
  if (content == null || content.length === 0) return true;
  return alternatives.some((parts) =>
    parts.every((part) => content.length >= part.offset + part.bytes.length && part.bytes.every((byte, i) => content[part.offset + i] === byte))
  );
}
