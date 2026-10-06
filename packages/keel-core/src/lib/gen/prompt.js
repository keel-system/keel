// Cuestionario interactivo con @clack/prompts: selección navegable con flechas
// e input de texto con validación. Sin TTY (tests, CI, pipes) o con --defaults,
// devuelve el default sin preguntar (los tests no deben colgarse esperando input).

import * as clack from '@clack/prompts';

function noTTY(defaults) {
  return defaults || !process.stdin.isTTY;
}

function ensureNotCancelled(value) {
  if (clack.isCancel(value)) {
    clack.cancel('Operación cancelada.');
    process.exit(1);
  }
}

/**
 * Pregunta una elección entre opciones [{ id, label }].
 * Navegación con flechas. Devuelve el id elegido; sin TTY/--defaults → defaultId.
 */
export async function select(question, options, defaultId, { defaults = false } = {}) {
  if (noTTY(defaults)) return defaultId;

  const answer = await clack.select({
    message: question,
    initialValue: defaultId,
    options: options.map((option) => ({
      value: option.id,
      label: option.label,
      hint: option.id === defaultId ? 'default' : undefined
    }))
  });
  ensureNotCancelled(answer);
  return answer;
}

/**
 * Pregunta un texto libre con validación opcional.
 * Devuelve el texto (o defaultValue si se deja vacío); sin TTY/--defaults → defaultValue.
 */
export async function promptText(question, { defaultValue = '', validate, defaults = false } = {}) {
  if (noTTY(defaults)) return defaultValue;

  const answer = await clack.text({
    message: question,
    placeholder: defaultValue,
    defaultValue,
    validate
  });
  ensureNotCancelled(answer);
  const trimmed = String(answer ?? '').trim();
  return trimmed || defaultValue;
}
