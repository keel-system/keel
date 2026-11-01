// Los sabotajes del almacenamiento (tramo 13f): cada uno rompe UNA garantía de la subida o de la política de un bucket en
// el Go emitido para catalog-extended (la fixture con una subida de campos con muestra y un bucket público), conservando
// que compile, y nombra las pruebas EMITIDAS que tienen que salir en rojo, y solo ellas. Los ejecuta go-check, y
// test/storage.test.js comprueba sin Go que cada uno se sigue aplicando al texto de hoy y que nombra pruebas que existen.

export const STORAGE_SUBJECT = 'catalog-extended';

export const STORAGE_SABOTAGES = [
  {
    id: 'multipart-limit',
    what: 'el borde pone a un multipart el tope de un JSON (30 MB) y no el de la subida',
    file: 'internal/httpapi/multipart.go',
    find: '\t\treturn MultipartLimitBytes\n',
    replace: '\t\treturn MaxBodyBytes\n',
    packages: './internal/httpapi/',
    fails: 'TestUnCuerpoPorTrozosQuePasaDelLimiteEs413ConElCodeDelDiseno'
  },
  {
    id: 'multipart-empty',
    what: 'una parte binaria que llega vacía pasa como un archivo',
    file: 'internal/httpapi/multipart.go',
    find: '\t\tcase len(content) == 0:\n',
    replace: '\t\tcase len(content) < 0:\n',
    packages: './internal/httpapi/',
    fails: 'TestUnaParteObligatoriaVaciaEs400FileUnreadable'
  },
  {
    id: 'multipart-missing',
    what: 'la parte obligatoria que no llegó se lee como vacía',
    file: 'internal/httpapi/multipart.go',
    find: '\tfile, ok := f.files[name]\n\tif !ok {',
    replace: '\tfile, ok := f.files[name]\n\tif !ok && file != nil {',
    packages: './internal/httpapi/',
    fails: 'TestUnaSubidaVaciaEchaEnFaltaLoPrimeroQueElMensajePideComoKeelSpring'
  },
  {
    id: 'signature',
    what: 'la firma del contenido no se mira: cualquier binario pasa por su tipo declarado',
    file: 'internal/domain/bucket_policy.go',
    find: '\t\tif matchesAll(content, parts) {',
    replace: '\t\tif len(parts) > 0 {',
    packages: './internal/domain/',
    fails: 'TestBucketPolicy',
    alsoFails: ['TestMatchesSignatureReconoceCadaTipoDeLaTabla']
  }
];

/** El texto saboteado, o null si lo que busca ya no está (el sabotaje no falsaría nada). */
export function applySabotage(sabotage, text) {
  return text.includes(sabotage.find) ? text.replace(sabotage.find, sabotage.replace) : null;
}
