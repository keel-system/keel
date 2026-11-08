// El gate de los plazos de negocio (DSL 2.26, D5 de PLAN-DSL-226-PLAZOS.md): `infra/check-deadlines.sh`, el de keel-spring
// con las formas de Go.
//
// build genera el cronómetro, el armado, la revalidación y el rechazo tardío ENTEROS. Lo que deja al agente son dos
// cosas, y las dos se pueden perder sin que nada falle:
//
//   · el handler de la operación `by`, que caduca la entidad, y el método semántico que aplica esa transición. Sin ellos,
//     el cronómetro despacha, el stub devuelve ErrNotImplemented, el temporizador se reintenta hasta aparcarse y la
//     entidad no caduca nunca — el «barrido que nunca reclama» de las corridas de 2.18, con otro nombre;
//   · la hora que el handler de una transición tardía le da al dominio. Con time.Now() el rechazo sigue saliendo, pero el
//     segundo exacto del vencimiento deja de poder probarse, que es para lo que existe el reloj inyectable.
//
// Es un gate de AUSENCIA, como check-domain-guards.sh: nace ROJO sobre el árbol recién generado (los stubs devuelven
// ErrNotImplemented) y lo cierra el agente. Caza la falta, no juzga el sitio. Y borra comentarios antes de mirar: las
// notas que build deja en los stubs nombran lo que falta, y sin eso el gate saldría verde por su propia prosa.

import { lateTransitionNote, modelDeadlines } from '@keel-system/keel-core/gen/deadlines';
import { constantOf } from './enums.js';
import { goFileName, layout } from './render.js';
import { handlerType, operations } from './services.js';
import { CLOCK } from './timer.js';

export function usesDeadlinesCheck(model) {
  return modelDeadlines(model).length > 0 && Boolean(model.layersPresent?.persistence);
}

export function generate(model) {
  if (!usesDeadlinesCheck(model)) return [];
  return [{ path: 'infra/check-deadlines.sh', content: script(model) }];
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/** Las filas del gate, como datos: `{ kind, args }`. Las prueba test/deadlines.test.js ejecutando el bash. */
export function deadlineChecks(model) {
  const { domain, application } = layout(model);
  const rows = [];
  for (const { entity, deadline } of modelDeadlines(model)) {
    const by = operations(model).find((operation) => operation.name === deadline.by);
    const subject = `${entity.name}.${deadline.stateName}`;
    // La entidad aplica el destino de la caducidad (el método semántico que llama a transitionTo o transitionAt).
    const target = constantOf(model, entity.lifecycle.enumType, deadline.to);
    rows.push({ kind: 'transition', args: [subject, `${domain.dir}/${goFileName(entity.name)}_behavior.go`, `transition(To|At)[(]${target}[,)]`] });
    // El handler de `by` caduca de verdad: ya no devuelve ErrNotImplemented y guarda la entidad.
    if (by) rows.push({ kind: 'expiring', args: [subject, `${application.dir}/${goFileName(handlerType(by))}.go`, by.name] });
  }
  // Quien saca la entidad de un estado con plazo hacia otro destino le da al dominio la hora del reloj inyectable.
  for (const operation of operations(model)) {
    if (lateTransitionNote(model, operation)) rows.push({ kind: 'clock', args: [operation.name, `${application.dir}/${goFileName(handlerType(operation))}.go`] });
  }
  return rows;
}

function script(model) {
  const rows = deadlineChecks(model).map(({ kind, args }) => `${kind} ${args.map(shellQuote).join(' ')}`);
  return `#!/usr/bin/env bash
# check-deadlines.sh — comprueba lo que el agente tiene que escribir para que los plazos de
# ${model.service.name} (DSL 2.26) caduquen de verdad.
#
# build genera el cronómetro, el armado del temporizador, la revalidación y el rechazo tardío
# del dominio. Lo del agente es el handler de la operación que caduca (sin él, el cronómetro
# despacha, el stub devuelve ErrNotImplemented y la entidad no caduca nunca), el método
# semántico de la entidad que aplica esa transición, y la hora del reloj inyectable en los
# handlers que salen del estado.
#
# Es una comprobación ESTRUCTURAL: caza la ausencia, no juzga el sitio.
#
# Uso (desde la raíz del proyecto; no necesita infraestructura ni compilar):
#   bash infra/check-deadlines.sh
#
# Código de salida:
#   0  todo lo que el agente tiene que escribir está escrito
#   1  hay hallazgos → vuelven al agente de código
set -u

if [ ! -d "internal" ]; then
  echo "Ejecuta el script desde la raíz del proyecto (no se encontró internal/)." >&2
  exit 1
fi

findings=0
detail=""

note() {  # texto
  detail="$detail  $1\\n"
  findings=$((findings + 1))
}

# El código de un archivo sin comentarios: las notas de build nombran lo que falta.
code_of() {  # ruta del archivo
  [ -f "$1" ] || return 1
  sed -e 's://.*::' "$1"
}

transition() {  # sujeto, archivo de la entidad, llamada (expresión)
  local code
  code="$(code_of "$2")" || { note "$1: no existe $2 — lo genera build; regenera el proyecto"; return; }
  printf '%s' "$code" | grep -qE -- "$3" || note "$1: la entidad no aplica la caducidad — falta el método semántico que llama a transitionTo o transitionAt con el estado de destino"
}

expiring() {  # sujeto, archivo del handler, operación
  local code
  code="$(code_of "$2")" || { note "$1: no existe $2 — lo genera build; regenera el proyecto"; return; }
  if printf '%s' "$code" | grep -qF -- 'ErrNotImplemented'; then
    note "$1: el handler de $3 sigue siendo el stub — el cronómetro lo despacha, falla, y la entidad no caduca nunca"
    return
  fi
  printf '%s' "$code" | grep -qE -- '[.]Save[(]' || note "$1: el handler de $3 no guarda la entidad — la caducidad no llega a la base"
}

clock() {  # operación, archivo del handler
  local code
  code="$(code_of "$2")" || { note "$1: no existe $2 — lo genera build; regenera el proyecto"; return; }
  if printf '%s' "$code" | grep -qE -- 'time[.]Now[(]'; then
    note "$1: lee la hora de la instancia en el sitio — pásale al dominio h.${CLOCK.param}(), el reloj inyectable"
    return
  fi
  printf '%s' "$code" | grep -qE -- 'h[.]${CLOCK.param}[(][)]' || note "$1: no le da al dominio la hora del reloj inyectable (h.${CLOCK.param}()) — sin ella no hay rechazo tardío"
}

${rows.join('\n')}

echo ""
echo "PLAZOS DE NEGOCIO"
if [ "$findings" -eq 0 ]; then echo "  deadlines            OK"; else echo "  deadlines            KO"; fi

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "HALLAZGOS ($findings)"
  printf '%b' "$detail"
  echo ""
  echo "El cronómetro, el armado y el rechazo tardío los genera build. La operación que caduca la"
  echo "escribes tú: su handler carga la entidad, llama a su método semántico (que aplica la"
  echo "transición con transitionTo) y la guarda. Y quien saca la entidad del estado con plazo le"
  echo "pasa al dominio h.${CLOCK.param}() y los plazos vigentes (transitionAt), nunca time.Now()."
  exit 1
fi

exit 0
`;
}
