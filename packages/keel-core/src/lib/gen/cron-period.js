// Cada cuánto vuelve a correr un `schedule` del diseño, en segundos.
//
// Existe porque los helpers de espera del arnés tienen que dimensionarse contra la
// cadencia real del mecanismo que alimentan: un `await` con techo de 15 s sobre un
// efecto que solo ocurre cuando pasa un barrido de 60 s falla según la fase del minuto
// en que arranque la suite — unas veces sí y otras no, que es peor que fallar siempre.
//
// NO es un parser de cron y no pretende serlo: no resuelve la próxima ejecución ni
// entiende rangos, listas de días ni nombres de mes. Devuelve una COTA SUPERIOR del
// intervalo entre dos ejecuciones, que es lo único que hace falta para dimensionar una
// espera — pasarse de largo alarga un test, quedarse corto lo vuelve intermitente. De
// ahí los cuatro escalones: por debajo del minuto no hay nada que distinguir (el cron
// del DSL son cinco campos, sin segundos: common.schema.json § cron).

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function cronPeriodSeconds(cron) {
  if (typeof cron !== 'string') return null;
  const [minute, hour] = cron.trim().split(/\s+/);
  if (!minute) return null;

  if (minute === '*') return MINUTE;

  const everyNMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyNMinutes) return Number(everyNMinutes[1]) * MINUTE;

  // Minutos concretos. Si la hora es libre se repite cada hora; si no, el barrido
  // ocurre a horas fijas y la cota se va al día. Contar cuántos minutos lista daría
  // un número menor, pero también uno peor: los huecos de una lista no son iguales
  // (`0,1,2 * * * *` corre tres veces seguidas y luego espera 58 minutos), y la cota
  // tiene que cubrir el hueco MAYOR, no el promedio.
  if (hour === '*' || /^\*\/\d+$/.test(hour ?? '')) return HOUR;
  return DAY;
}

/**
 * La cadencia más rápida declarada en el servicio, o null si no hay ninguna.
 *
 * Se toma la MÁS RÁPIDA y no la más lenta a propósito: lo que se está dimensionando es
 * cuánto tarda en pasar el barrido que empuja el trabajo pendiente, y ese es el que
 * corre a menudo. La purga diaria de datos personales también es un `schedule`, pero
 * nadie espera por ella en una prueba de integración — incluirla en el máximo pondría
 * el techo en 24 h y ninguna espera volvería a fallar por nada.
 */
export function fastestSchedulePeriod(model) {
  const periods = (model.services ?? [])
    .flatMap((service) => service.operations ?? [])
    .map((operation) => cronPeriodSeconds(operation.schedule?.cron))
    .filter((seconds) => typeof seconds === 'number');
  return periods.length > 0 ? Math.min(...periods) : null;
}
