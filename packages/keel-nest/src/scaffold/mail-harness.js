// El arnés del BUZÓN (incremento 12e): los helpers con los que un flujo afirma sobre el correo que salió. Los
// mismos que el AbstractFlowIT de keel-spring (`awaitMailTo`, `lastMailTo`, `mailCount`, `assertNoMailTo`,
// `relayRejectsRecipients`, `rejectedAddress`, `relayAccepts`, `mailSubject`, `mailHtml`, `mailText`,
// `mailFrom`), con el vocabulario de keel-core (`gen/mail-probes.js`): las rutas, los campos, la repaginación y
// el rechazo hablan con el mismo Mailpit, y salen del mismo módulo que el sondeo de validate-infra.sh y la
// purga de reset-db.sh.
//
// `test/integration/support/mail.ts` no importa Nest ni vitest: solo `fetch`. Es lo que permite ejecutarlo en
// las pruebas de keel-nest contra un buzón falso; `flow.ts` lo reexporta, y los flujos siguen importando solo de
// `flow.ts` (regla `flujos-caja-negra`).

import {
  HOST_BASE,
  HTTP_PORT,
  ROUTES,
  SEARCH_PREFIX,
  SEARCH_LIMIT,
  SEARCH_LIMIT_PARAM,
  searchSuffix,
  CHAOS_REJECT_CODE,
  CHAOS_REJECT_RECIPIENTS,
  CHAOS_OFF,
  REJECTED_DOMAIN
} from 'keel-core/gen/mail-probes';
import { fastestSchedulePeriod } from 'keel-core/gen';
import { tsString } from './render.js';
import { usesMail } from './mail.js';

export const MAIL_HARNESS_TS = 'test/integration/support/mail.ts';

// Los mismos tres números que keel-spring (mail-harness.js): suelo sin barrido, margen sobre su periodo y techo.
const MAIL_AWAIT_FLOOR = 15;
const MAIL_AWAIT_MARGIN = 15;
const MAIL_AWAIT_CAP = 300;

/**
 * Cuántos segundos espera el arnés a que llegue un correo, derivado del contrato (la misma regla que keel-spring):
 * si el correo lo empuja un barrido con `schedule`, una espera menor que su periodo falla según la fase en que
 * arranque la suite —verde o rojo por el reloj, no por el código—.
 */
export function mailAwaitSeconds(model) {
  const drivenBySweep = (model.mail?.sentBy ?? []).some((name) =>
    (model.services ?? []).some((service) =>
      (service.operations ?? []).some((operation) => operation.name === name && (operation.internal || operation.schedule))
    )
  );
  const period = drivenBySweep ? fastestSchedulePeriod(model) : null;
  if (period == null) return { seconds: MAIL_AWAIT_FLOOR, period: null };
  return { seconds: Math.min(MAIL_AWAIT_CAP, Math.max(MAIL_AWAIT_FLOOR, period + MAIL_AWAIT_MARGIN)), period };
}

export function generate(model) {
  return usesMail(model) ? [{ path: MAIL_HARNESS_TS, content: mailHarnessTs(model) }] : [];
}

/** Los nombres que flow.ts reexporta. */
export const MAIL_HARNESS_EXPORTS = [
  'MailMessageView',
  'awaitMailTo',
  'lastMailTo',
  'mailCount',
  'assertNoMailTo',
  'relayRejectsRecipients',
  'rejectedAddress',
  'relayAccepts',
  'mailSubject',
  'mailHtml',
  'mailText',
  'mailFrom'
];

function mailHarnessTs(model) {
  const senders = model.mail.sentBy.join(', ');
  const parts = model.mail.multipart ? 'las dos partes del cuerpo (HTML y texto)' : model.mail.hasHtml ? 'solo el cuerpo HTML' : 'solo el cuerpo en texto';
  const wait = mailAwaitSeconds(model);
  const tooSlow = wait.period != null && wait.period + MAIL_AWAIT_MARGIN > MAIL_AWAIT_CAP;
  return `/**
 * El buzón de prueba: el Mailpit de infra/docker-compose.yaml, al que el perfil \`local\` entrega el correo. El
 * reset de estado (\`resetState()\`, al empezar cada flujo) lo vacía y le quita el rechazo: un correo de un
 * flujo anterior haría que el primer awaitMailTo devolviera el mensaje equivocado.
 *
 * Los mismos helpers que el arnés de keel-spring, con el vocabulario del buzón de keel-core. Se importan de
 * flow.ts, nunca de aquí.
 */

/** API del buzón (o \`MAIL_API\` del entorno). */
const MAIL_API = process.env.MAIL_API ?? ${tsString(HOST_BASE)};

/**
 * Techo de cualquier espera de correo, en segundos.${
    wait.period == null
      ? `
 *
 * El correo sale dentro de la operación que atiende la petición: no hay barrido de por medio y lo único que
 * cubre esta espera es el viaje al relay.`
      : `
 *
 * Sale del contrato, no de un número redondo: el correo lo empuja un barrido con cadencia de ${wait.period} s (el
 * \`schedule\` más rápido del diseño), y una espera más corta que su periodo falla según la fase en que arranque
 * la suite. Lleva ${MAIL_AWAIT_MARGIN} s de margen por el desfase que build reparte entre barridos de la misma cadencia.`
  }${
    tooSlow
      ? `
 *
 * OJO: ese periodo excede el techo de ${MAIL_AWAIT_CAP} s y se ha recortado ahí. Ningún escenario que dependa del
 * barrido va a pasar tal cual: si tiene que ser verificable, el diseño necesita un disparador además del \`schedule\`.`
      : ''
  }
 */
export const MAIL_AWAIT_SECONDS = ${wait.seconds};

/** Techo de una búsqueda en el buzón, y el punto donde se repagina (ver mailIdsTo). */
const MAIL_SEARCH_LIMIT = ${SEARCH_LIMIT};

/** Un mensaje completo del buzón, tal como lo devuelve su API. */
export type MailMessageView = Readonly<Record<string, unknown>>;

/**
 * Espera a que haya \`count\` correos para esa dirección y devuelve sus ids, el más reciente primero.
 *
 * ES EL HELPER CON EL QUE EMPIEZA CUALQUIER THEN SOBRE CORREO, y la espera no es opcional. Las operaciones que
 * lo mandan (${senders}) responden aceptando el encargo, no habiéndolo cumplido: la entrega ocurre DESPUÉS de
 * la respuesta. Una lectura seca justo tras el 2xx es una carrera, y el escenario fallaría unas veces sí y otras no.
 */
export async function awaitMailTo(address: string, count: number): Promise<string[]> {
  let ids: string[] = [];
  const deadline = Date.now() + MAIL_AWAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    ids = await mailIdsTo(address);
    if (ids.length >= count) return ids;
    await sleep(200);
  }
  throw new Error(
    \`Se esperaban \${count} correo(s) para \${address} y llegaron \${ids.length} en \${MAIL_AWAIT_SECONDS} s. El buzón se mira en http://localhost:${HTTP_PORT}\`
  );
}

/** El correo más reciente para esa dirección, ya resuelto a su detalle completo. */
export async function lastMailTo(address: string): Promise<MailMessageView> {
  const [id] = await awaitMailTo(address, 1);
  return mailMessage(id!);
}

/**
 * Cuántos correos hay AHORA para esa dirección, sin esperar.
 *
 * Para el Then que afirma que no se duplicó: se espera primero al que sí debe llegar (con awaitMailTo) y solo
 * entonces se cuenta. Contar sin haber esperado nada mide el estado de antes, y eso sale verde siempre.
 */
export async function mailCount(address: string): Promise<number> {
  return (await mailIdsTo(address)).length;
}

/**
 * Que NO salió ningún correo para esa dirección: el Then de los rechazos. Espera un margen a propósito —el MISMO
 * techo que awaitMailTo—: sin él, «no ha llegado» y «todavía no ha llegado» son indistinguibles, y el escenario
 * pasaría en verde también cuando el correo acaba saliendo un momento más tarde.
 */
export async function assertNoMailTo(address: string): Promise<void> {
  await sleep(MAIL_AWAIT_SECONDS * 1000);
  const count = await mailCount(address);
  if (count > 0) throw new Error(\`No debía salir ningún correo para \${address} y salieron \${count}\`);
}

/**
 * A partir de aquí el relay de prueba RECHAZA todo destinatario con un ${CHAOS_REJECT_CODE} (rechazo permanente), hasta
 * relayAccepts() o hasta el reset del siguiente flujo. Es como se alcanza en caja negra el envío que acaba
 * fallido, sin fabricarlo escribiendo en el almacén. Es GLOBAL: el Given lo activa justo antes del When.
 */
export async function relayRejectsRecipients(): Promise<void> {
  await mailPut(${tsString(ROUTES.chaos())}, ${tsString(CHAOS_REJECT_RECIPIENTS)});
}

/**
 * Una dirección que el relay de prueba RECHAZA siempre, ella sola (un ${CHAOS_REJECT_CODE} a su RCPT TO), mientras el
 * resto de destinatarios del mismo envío se aceptan: el rechazo SELECTIVO. No hay que activarla: el buzón
 * arranca rechazando el dominio reservado ${REJECTED_DOMAIN} (RFC 2606).
 *
 * Ojo al afirmar: el buzón indexa la cabecera To, así que el correo que SÍ salió para los demás sigue NOMBRANDO
 * al rechazado. Que no le llegó se afirma por el desenlace del envío, no con assertNoMailTo.
 */
export function rejectedAddress(localPart: string): string {
  return \`\${localPart}@${REJECTED_DOMAIN}\`;
}

/** El relay vuelve a aceptarlo todo. El reset entre flujos lo hace siempre. */
export async function relayAccepts(): Promise<void> {
  await mailPut(${tsString(ROUTES.chaos())}, ${tsString(CHAOS_OFF)});
}

/** Asunto tal como lo lee quien recibe el correo: ya interpolado y ya saneado. */
export function mailSubject(message: MailMessageView): string {
  return String(message.Subject ?? '');
}

/** Cuerpo HTML. Cadena vacía si el mensaje no lleva parte HTML. */
export function mailHtml(message: MailMessageView): string {
  return message.HTML == null ? '' : String(message.HTML);
}

/** Cuerpo en texto plano. Este servicio envía ${parts}. */
export function mailText(message: MailMessageView): string {
  return message.Text == null ? '' : String(message.Text);
}

/** Dirección desde la que salió el correo: el remitente que el diseño resuelve por envío. */
export function mailFrom(message: MailMessageView): string | null {
  const from = message.From as { Address?: string } | null | undefined;
  return from?.Address ?? null;
}

/**
 * Ids de los correos para esa dirección, más reciente primero.
 *
 * La respuesta trae dos números: la lista, RECORTADA por limit, y el conteo de los que casan, que no se recorta.
 * Leer solo la lista pone un techo a mailCount y hace que awaitMailTo no se pueda satisfacer por encima de esa
 * cifra. Por eso se mira el total y, si supera el techo, se repite la búsqueda pidiendo exactamente ese total.
 */
async function mailIdsTo(address: string): Promise<string[]> {
  const query = encodeURIComponent(\`to:\${address}\`);
  let body = (await mailApi(\`${SEARCH_PREFIX}\${query}${searchSuffix()}\`)) as { messages_count?: number; messages?: { ID: string }[] };
  const matching = Number(body.messages_count ?? 0);
  if (matching > MAIL_SEARCH_LIMIT) body = (await mailApi(\`${SEARCH_PREFIX}\${query}${SEARCH_LIMIT_PARAM}\${matching}\`)) as typeof body;
  return (body.messages ?? []).map((message) => message.ID);
}

/** El mensaje COMPLETO por su id: la búsqueda solo trae el resumen, y sin esto no se afirma sobre el cuerpo. */
async function mailMessage(id: string): Promise<MailMessageView> {
  return (await mailApi(\`${ROUTES.message('')}\${id}\`)) as MailMessageView;
}

async function mailApi(path: string): Promise<unknown> {
  let response: globalThis.Response;
  try {
    response = await fetch(\`\${MAIL_API}\${path}\`);
  } catch (error) {
    throw new Error(\`No se pudo hablar con el buzón de prueba en \${MAIL_API}. ¿Está levantado el compose de infra/? (bash infra/validate-infra.sh)\`, { cause: error });
  }
  const text = await response.text();
  if (response.status >= 300) throw new Error(\`El buzón de prueba rechazó \${path} (HTTP \${response.status}): \${text}\`);
  return JSON.parse(text);
}

async function mailPut(path: string, json: string): Promise<void> {
  let response: globalThis.Response;
  try {
    response = await fetch(\`\${MAIL_API}\${path}\`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json });
  } catch (error) {
    throw new Error(\`No se pudo hablar con el buzón de prueba en \${MAIL_API}\`, { cause: error });
  }
  if (response.status >= 300) {
    throw new Error(\`El buzón de prueba rechazó \${path} (HTTP \${response.status}): \${await response.text()}. ¿Arrancó con MP_ENABLE_CHAOS? (infra/docker-compose.yaml)\`);
  }
}

function sleep(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}
`;
}
