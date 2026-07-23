import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { LAYERS } from '../lib/assets.js';
import { resolveServiceRef } from '../lib/loader.js';
import { summarizeService } from '../lib/summarize-service.js';

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function printDomain(domain) {
  console.log(
    pc.bold('domain') +
      pc.dim(
        ` — ${plural(domain.entities.length, 'entidad', 'entidades')}, ${plural(domain.typeCount, 'type', 'types')}, ${plural(domain.aggregates.length, 'agregado', 'agregados')}`
      )
  );
  for (const entity of domain.entities) {
    const notes = [];
    if (entity.aggregateRoot) notes.push(`raíz del agregado ${entity.aggregate}`);
    else if (entity.aggregate) notes.push(`en agregado ${entity.aggregate}`);
    if (entity.lifecycle) notes.push('lifecycle');
    console.log(`  ${pc.dim('•')} ${entity.name}${notes.length > 0 ? pc.dim(` (${notes.join(', ')})`) : ''}`);
  }
}

function printUseCases(useCases) {
  const commands = useCases.operations.filter((op) => op.kind === 'command').length;
  const queries = useCases.operations.filter((op) => op.kind === 'query').length;
  console.log(
    pc.bold('use-cases') +
      pc.dim(` — ${plural(useCases.operations.length, 'operación', 'operaciones')} (${commands} command, ${queries} query)`)
  );
  for (const op of useCases.operations) {
    const notes = [];
    if (op.internal) notes.push('interna');
    if (op.schedule) notes.push('schedule');
    const emits = op.emits.length > 0 ? pc.dim(` → emite ${op.emits.join(', ')}`) : '';
    console.log(
      `  ${pc.dim('•')} ${op.name}  ${pc.cyan(op.kind ?? '?')}${emits}${notes.length > 0 ? pc.dim(` (${notes.join(', ')})`) : ''}`
    );
  }
}

function printApi(api) {
  const parts = [];
  if (api.style) parts.push(api.style);
  if (api.basePath) parts.push(api.basePath);
  if (api.auto) parts.push('rutas CRUD automáticas');
  if (api.endpoints.length > 0) parts.push(plural(api.endpoints.length, 'endpoint explícito', 'endpoints explícitos'));
  if (api.defaultAudience && api.defaultAudience !== 'users') parts.push(`audiencia por defecto: ${api.defaultAudience}`);
  console.log(pc.bold('api') + pc.dim(` — ${parts.join(', ')}`));
  for (const endpoint of api.endpoints) {
    const audience = endpoint.audience !== 'users' ? pc.dim(` → ${endpoint.audience}`) : '';
    console.log(`  ${pc.dim('•')} ${endpoint.operation}  ${pc.cyan(`${endpoint.method ?? '?'} ${endpoint.path ?? '?'}`)}${audience}`);
  }
}

function printSecurity(security) {
  const parts = [];
  if (security.authentication) parts.push(security.authentication);
  if (security.serviceAuth) {
    parts.push(
      `M2M: ${security.serviceAuth}${security.serviceClients.length > 0 ? ` (${plural(security.serviceClients.length, 'cliente', 'clientes')}: ${security.serviceClients.join(', ')})` : ''}`
    );
  }
  if (security.roles.length > 0) parts.push(`${plural(security.roles.length, 'rol', 'roles')} (${security.roles.join(', ')})`);
  if (security.defaultAccess) parts.push(`acceso por defecto: ${security.defaultAccess}`);
  console.log(pc.bold('security') + pc.dim(` — ${parts.join('; ')}`));
}

function printMessaging(messaging) {
  const parts = [];
  parts.push(`${plural(messaging.published.length, 'evento publicado', 'eventos publicados')}${messaging.published.length > 0 ? ` (${messaging.published.join(', ')})` : ''}`);
  parts.push(plural(messaging.subscriptions.length, 'suscripción', 'suscripciones'));
  if (messaging.reliability) parts.push(`reliability: ${messaging.reliability}`);
  console.log(pc.bold('messaging') + pc.dim(` — ${parts.join('; ')}`));
  for (const sub of messaging.subscriptions) {
    const notes = [];
    if (sub.source) notes.push(`de ${sub.source}`);
    if (sub.channel) notes.push(`canal ${sub.channel}${sub.external ? ' (externo)' : ''}`);
    if (sub.envelope) notes.push(`envelope ${sub.envelope}`);
    if (sub.format && sub.format !== 'json') notes.push(sub.format);
    if (sub.discriminator) notes.push(`discrimina por ${sub.discriminator}`);
    if (sub.triggers) notes.push(`dispara ${sub.triggers}`);
    console.log(`  ${pc.dim('•')} ${sub.name}${notes.length > 0 ? pc.dim(` (${notes.join(', ')})`) : ''}`);
  }
}

function printHttpClients(httpClients) {
  console.log(pc.bold('http-clients') + pc.dim(` — ${plural(httpClients.clients.length, 'cliente', 'clientes')}`));
  for (const client of httpClients.clients) {
    const notes = [];
    if (client.auth && client.auth !== 'none') notes.push(`auth: ${client.auth}`);
    notes.push(plural(client.calls.length, 'llamada', 'llamadas'));
    console.log(`  ${pc.dim('•')} ${client.name}${pc.dim(` (${notes.join(', ')})`)}`);
    for (const call of client.calls) {
      const route = call.method && call.path ? pc.cyan(`${call.method} ${call.path}`) : pc.dim('(contrato en prosa)');
      console.log(`      ${pc.dim('-')} ${call.name}  ${route}`);
    }
  }
}

function printPersistence(persistence) {
  const parts = [plural(persistence.entities.length, 'entidad persistida', 'entidades persistidas')];
  if (persistence.model) parts.push(`modelo ${persistence.model}`);
  console.log(pc.bold('persistence') + pc.dim(` — ${parts.join(', ')}`));
}

function printStorage(storage) {
  console.log(pc.bold('storage') + pc.dim(` — ${plural(storage.buckets.length, 'bucket', 'buckets')}`));
  for (const bucket of storage.buckets) {
    console.log(`  ${pc.dim('•')} ${bucket.name}  ${pc.cyan(bucket.visibility)}`);
  }
}

const LAYER_PRINTERS = {
  domain: ['domain', printDomain],
  'use-cases': ['useCases', printUseCases],
  api: ['api', printApi],
  security: ['security', printSecurity],
  messaging: ['messaging', printMessaging],
  'http-clients': ['httpClients', printHttpClients],
  persistence: ['persistence', printPersistence],
  storage: ['storage', printStorage]
};

export function describe(ref) {
  const resolved = resolveServiceRef(ref);
  if (resolved.error) {
    console.error(pc.red(resolved.error));
    process.exitCode = 1;
    return;
  }

  const { service, status, layers, summary } = summarizeService(resolved.dir);

  if (status.loadFailed) {
    for (const message of status.errors) console.error(pc.red(`✘ ${message}`));
    process.exitCode = 1;
    return;
  }

  const name = service.name ?? '(sin nombre)';
  const version = service.version ?? '?';
  console.log(pc.bold(`${name} v${version}`) + pc.dim(` — DSL keel ${service.dsl ?? '?'}`));
  if (service.domain) console.log(pc.dim(`  Dominio: ${service.domain}`));
  if (service.basedOn) console.log(pc.dim(`  Basado en: ${service.basedOn}`));
  if (service.description) console.log(`  ${service.description}`);
  console.log();

  if (status.errorCount > 0) {
    console.log(pc.bold(pc.red(`Estado del diseño: ✘ con errores — ${plural(status.errorCount, 'error', 'errores')}`)));
    for (const message of status.errors) console.log(`  ${pc.red('•')} ${message}`);
    console.log(pc.dim('  Detalle completo: keel validate'));
  } else if (status.pending.length > 0) {
    console.log(pc.bold(pc.yellow(`Estado del diseño: ⚠ en progreso — ${status.pending.length} pendiente(s)`)));
    for (const message of status.pending) console.log(`  ${pc.yellow('•')} ${message}`);
  } else {
    console.log(pc.bold(pc.green('Estado del diseño: ✔ completo')) + pc.dim(' (validación mecánica en verde)'));
  }
  console.log();

  console.log(pc.bold(`Capas (${layers.present.length} de ${LAYERS.length}):`) + ` ${layers.present.join(', ')}`);
  if (layers.absent.length > 0) console.log(pc.dim(`  Ausentes: ${layers.absent.join(', ')}`));
  console.log();

  for (const layer of layers.present) {
    const [key, print] = LAYER_PRINTERS[layer];
    print(summary[key]);
  }

  console.log();
  console.log(pc.bold('Reutilización:'));
  const fromRef = service.name ?? ref;
  console.log(`  ${pc.cyan(`keel new <nuevo-servicio> --from ${fromRef}`)}  clona este diseño con linaje basedOn`);
  if (service.name && fs.existsSync(path.join(process.cwd(), 'docs', service.name, 'DESIGN.md'))) {
    console.log(`  ${pc.cyan(`docs/${service.name}/DESIGN.md`)}  ficha de reutilización y decisiones de diseño`);
  }
}
