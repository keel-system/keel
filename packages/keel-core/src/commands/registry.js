import pc from 'picocolors';
import { supportedDsl } from '../lib/assets.js';
import { baseUrlOf, dslSupport, findDesign, loadRegistryIndex, searchDesigns } from '../lib/registry-source.js';

const MATURITY_LABEL = { reference: 'referencia', stable: 'estable', draft: 'borrador' };
const MATURITY_COLOR = { reference: pc.green, stable: pc.cyan, draft: pc.yellow };

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function maturityBadge(design) {
  const maturity = design.metadata?.maturity;
  if (!maturity) return '';
  return (MATURITY_COLOR[maturity] ?? pc.dim)(`[${MATURITY_LABEL[maturity]}]`);
}

function summaryOf(design) {
  return design.metadata?.summary ?? design.service?.description ?? '';
}

/**
 * Marca de DSL no soportado. Al hojear es un aviso, no un error: ver un diseño
 * que todavía no puedes derivar es legítimo, y verlo marcado es la información
 * útil. El bloqueo ocurre al derivar (`keel new --from registry:`).
 */
function dslBadge(design) {
  const support = dslSupport(design);
  if (support === 'ok') return '';
  if (support === 'nueva') return pc.red(`[DSL ${design.service.dsl} — actualiza keel-core]`);
  return pc.yellow('[DSL sin declarar]');
}

/** ¿Algún diseño de la lista queda fuera de lo que soporta esta CLI? */
function noteUnsupported(designs) {
  const unsupported = designs.filter((design) => dslSupport(design) === 'nueva');
  if (unsupported.length === 0) return;
  console.log(
    pc.yellow(
      `⚠ ${plural(unsupported.length, 'diseño', 'diseños')} usa${unsupported.length === 1 ? '' : 'n'} un DSL más nuevo que esta CLI ` +
        `(soporta: ${supportedDsl().join(', ')}). Actualiza keel-core para poder derivarlo${unsupported.length === 1 ? '' : 's'}.`
    )
  );
}

async function open(options) {
  const result = await loadRegistryIndex(options);
  if (result.error) {
    console.error(pc.red(result.error));
    process.exitCode = 1;
    return null;
  }
  for (const warning of result.warnings) console.error(`${pc.yellow('⚠')} ${warning}`);
  return result;
}

function printDesignLine(design, { indent = '  ' } = {}) {
  const version = design.service?.version ? pc.dim(` v${design.service.version}`) : '';
  const badges = [maturityBadge(design), dslBadge(design)].filter(Boolean).join(' ');
  console.log(`${indent}${pc.bold(design.slug)}${version} ${badges}`);
  const summary = summaryOf(design);
  if (summary) console.log(`${indent}  ${pc.dim(summary)}`);
}

/** `keel registry` / `keel registry list`: todo el registry, agrupado por familia. */
export async function listRegistry(options = {}) {
  const opened = await open(options);
  if (!opened) return;
  const { index, url, from } = opened;

  if (index.designs.length === 0) {
    console.log(pc.yellow('El registry no publica ningún diseño todavía.'));
    return;
  }

  const bySlug = new Map(index.designs.map((design) => [design.slug, design]));
  console.log(
    pc.bold(`Registry de diseños Keel`) +
      pc.dim(` — ${plural(index.designs.length, 'diseño', 'diseños')} en ${plural(index.families.length, 'familia', 'familias')} (${from})`)
  );
  console.log();

  for (const family of index.families) {
    const members = family.designs.map((slug) => bySlug.get(slug)).filter(Boolean);

    if (members.length === 1) {
      printDesignLine(members[0], { indent: '' });
      console.log();
      continue;
    }

    console.log(pc.bold(pc.underline(family.name)) + pc.dim(` — ${plural(members.length, 'variante', 'variantes')}`));
    for (const design of members) {
      printDesignLine(design);
      const differs = design.metadata?.differsIn;
      if (differs) console.log(`    ${pc.dim(`difiere en: ${differs}`)}`);
    }
    console.log();
  }

  noteUnsupported(index.designs);
  console.log(pc.dim(`Fuente: ${url}`));
  console.log(`Ficha completa: ${pc.cyan('keel registry show <diseño>')}`);
  console.log(`Reutilizar:     ${pc.cyan('keel new <mi-servicio> --from registry:<diseño>')}`);
}

/** `keel registry search <término>`: filtra por slug, tags, dominio o prosa. */
export async function searchRegistry(term, options = {}) {
  const opened = await open(options);
  if (!opened) return;
  const { index } = opened;

  const matches = searchDesigns(index, term);
  if (matches.length === 0) {
    console.log(pc.yellow(`Ningún diseño coincide con '${term}'.`));
    console.log(pc.dim(`  Lista todo con \`keel registry\`.`));
    return;
  }

  console.log(pc.bold(`${plural(matches.length, 'diseño', 'diseños')} para '${term}'`));
  console.log();
  for (const design of matches) {
    printDesignLine(design, { indent: '' });
    const tags = design.metadata?.tags;
    if (tags?.length > 0) console.log(`  ${pc.dim(tags.join(' · '))}`);
    console.log();
  }
  noteUnsupported(matches);
}

/** `keel registry show <slug>`: la ficha completa, sin descargar el diseño. */
export async function showRegistryDesign(slug, options = {}) {
  const opened = await open(options);
  if (!opened) return;
  const { index, url } = opened;

  const { design, error } = findDesign(index, slug);
  if (error) {
    console.error(pc.red(error));
    process.exitCode = 1;
    return;
  }

  const service = design.service ?? {};
  const badges = [maturityBadge(design), dslBadge(design)].filter(Boolean).join(' ');
  console.log(pc.bold(`${design.slug} v${service.version ?? '?'}`) + pc.dim(` — DSL keel ${service.dsl ?? '?'}`) + ` ${badges}`);
  if (design.variant) console.log(pc.dim(`  Familia: ${design.family} · variante: ${design.variant}`));
  if (service.domain) console.log(pc.dim(`  Dominio: ${service.domain}`));
  if (service.basedOn) console.log(pc.dim(`  Basado en: ${service.basedOn}`));
  const metadata = design.metadata;
  if (metadata?.author || metadata?.license) {
    console.log(pc.dim(`  ${[metadata.author, metadata.license].filter(Boolean).join(' · ')}`));
  }
  console.log();
  console.log(`  ${summaryOf(design)}`);
  if (metadata?.differsIn) console.log(`  ${pc.dim(`Difiere del resto de su familia: ${metadata.differsIn}`)}`);
  console.log();

  if (metadata?.tags?.length > 0) console.log(pc.bold('Tags: ') + pc.dim(metadata.tags.join(' · ')));
  console.log(pc.bold(`Capas (${design.layers.length}): `) + design.layers.join(', '));

  const counts = design.counts ?? {};
  const shape = [
    ['entidad', 'entidades', counts.entities],
    ['operación', 'operaciones', counts.operations],
    ['endpoint', 'endpoints', counts.endpoints],
    ['evento', 'eventos', counts.publishedEvents],
    ['suscripción', 'suscripciones', counts.subscriptions],
    ['rol', 'roles', counts.roles],
    ['bucket', 'buckets', counts.buckets]
  ].filter(([, , value]) => typeof value === 'number' && value > 0);
  if (shape.length > 0) {
    console.log(
      pc.bold('Contenido: ') +
        pc.dim(shape.map(([singular, pluralForm, value]) => plural(value, singular, pluralForm)).join(', '))
    );
  }

  if (design.metadata?.requires?.length > 0) {
    console.log(pc.bold('Consume: ') + design.metadata.requires.map((name) => `registry:${name}`).join(', '));
  }

  const base = baseUrlOf(url);
  const docs = design.docs ?? {};
  const links = [
    ['Diseño y decisiones', docs.design],
    ['Panel visual', docs.overview],
    ['Contrato de integración', docs.integration]
  ].filter(([, file]) => file);
  if (links.length > 0) {
    console.log();
    console.log(pc.bold('Documentación:'));
    for (const [label, file] of links) console.log(`  ${pc.dim('•')} ${label}: ${pc.cyan(`${base}${file}`)}`);
  }

  console.log();
  if (dslSupport(design) === 'nueva') {
    console.log(pc.bold(pc.red('No derivable con esta CLI:')));
    console.log(
      `  El diseño usa el DSL keel ${service.dsl} y esta CLI soporta ${supportedDsl().join(', ')}.\n` +
        `  Actualiza keel-core: ${pc.cyan('npm i -g keel-core@latest')}`
    );
    return;
  }
  console.log(pc.bold('Reutilización:'));
  console.log(`  ${pc.cyan(`keel new <mi-servicio> --from registry:${design.slug}`)}`);
}
