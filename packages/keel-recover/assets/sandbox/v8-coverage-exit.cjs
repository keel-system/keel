// Instrumentación del sandbox (keel-recover), no código del legacy: se monta en el contenedor y se
// carga con NODE_OPTIONS=--require. Node solo escribe NODE_V8_COVERAGE cuando el proceso SALE:
// con la señal con la que `stop` lo para (SIGTERM) muere sin escribir nada. Convertir la señal en
// una salida ordenada es lo único que hace este archivo, y solo si el legacy no instala su propio
// manejador (en ese caso, ya decide él cómo salir).
'use strict';

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (process.listenerCount(signal) > 1) return;
    process.exit(0);
  });
}
