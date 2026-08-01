import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { isKeelWorkspace, supportedDsl } from '../lib/assets.js';
import { MANIFEST_FILE } from '../lib/loader.js';
import { SIDECAR_FILE } from '../lib/design-index.js';
import { stampAdoptedManifest } from '../lib/derive.js';
import { copyTree } from '../lib/copy.js';
import {
  baseUrlOf,
  downloadDesign,
  dslMismatchMessage,
  dslSupport,
  findDesign,
  loadRegistryIndex,
  searchDesigns
} from '../lib/registry-source.js';

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
  if (support === 'incompatible') return pc.red(`[DSL ${design.service.dsl} — incompatible]`);
  return pc.yellow('[DSL sin declarar]');
}

/** ¿Algún diseño de la lista queda fuera de lo que soporta esta CLI? */
function noteUnsupported(designs) {
  const unsupported = designs.filter((design) => dslSupport(design) === 'incompatible');
  if (unsupported.length === 0) return;
  console.log(
    pc.yellow(
      `⚠ ${plural(unsupported.length, 'diseño', 'diseños')} usa${unsupported.length === 1 ? '' : 'n'} un DSL que esta CLI no acepta ` +
        `(soporta: ${supportedDsl().join(', ')}). 'keel registry show <diseño>' dice qué hacer con cada uno.`
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
  console.log(`Adoptar:        ${pc.cyan('keel registry get <diseño>')} ${pc.dim('— tal cual, listo para generar')}`);
  console.log(`Derivar:        ${pc.cyan('keel new <mi-servicio> --from registry:<diseño>')} ${pc.dim('— para ajustarlo')}`);
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
  if (dslSupport(design) === 'incompatible') {
    console.log(pc.bold(pc.red('No derivable con esta CLI:')));
    console.log(
      `  El diseño usa el DSL keel ${service.dsl} y esta CLI soporta ${supportedDsl().join(', ')}.\n` +
        `  Actualiza keel-core: ${pc.cyan('npm i -g keel-core@latest')}`
    );
    return;
  }
  console.log(pc.bold('Reutilización:'));
  console.log(`  ${pc.cyan(`keel registry get ${design.slug}`)}  tal cual, con sus derivados al día`);
  console.log(`  ${pc.cyan(`keel new <mi-servicio> --from registry:${design.slug}`)}  derivarlo para ajustarlo`);
}

/**
 * `keel registry get <slug>`: **adoptar** un diseño, no derivarlo.
 *
 * Trae el diseño tal cual —mismo nombre, misma versión, misma description— con
 * sus derivados en `docs/<slug>/`, donde `keel describe` los ve al día y
 * `keel-<tech> build` los recoge. Es la otra intención frente a `keel new
 * --from registry:`, que renombra, resetea a 0.1.0 y obliga a regenerarlo todo:
 * derivar para adoptar significaría reconstruir a mano artefactos que ya
 * existían y ya pasaron el CI del registry.
 */
export async function getRegistryDesign(slug, options = {}) {
  const cwd = process.cwd();
  if (!isKeelWorkspace(cwd)) {
    console.error(pc.red('Este directorio no es un workspace Keel. Ejecuta primero: keel init'));
    process.exitCode = 1;
    return;
  }

  const serviceDir = path.join(cwd, 'specs', slug);
  if (fs.existsSync(serviceDir) && !options.force) {
    console.error(pc.red(`Ya existe specs/${slug}.`));
    console.error(pc.dim('  Usa --force para reemplazarlo, o `keel new <otro> --from registry:' + slug + '` para derivarlo con otro nombre.'));
    process.exitCode = 1;
    return;
  }

  // Adoptar es materializar un diseño, no hojear el catálogo: se revalida el
  // índice igual que al derivar (ver el comentario en new.js).
  const loaded = await loadRegistryIndex({ ...options, refresh: options.offline ? false : true });
  if (loaded.error) {
    console.error(pc.red(loaded.error));
    process.exitCode = 1;
    return;
  }
  for (const warning of loaded.warnings) console.error(`${pc.yellow('⚠')} ${warning}`);

  const { design, error } = findDesign(loaded.index, slug);
  if (error) {
    console.error(pc.red(error));
    process.exitCode = 1;
    return;
  }

  if (dslSupport(design) === 'incompatible') {
    console.error(pc.red(`✘ ${dslMismatchMessage(design)}`));
    process.exitCode = 1;
    return;
  }

  const version = design.service?.version ?? '?';
  console.log(pc.dim(`Descargando ${design.slug} v${version} de ${loaded.url} (índice: ${loaded.from})…`));
  const downloaded = await downloadDesign(design, { indexUrl: loaded.url });
  if (downloaded.error) {
    console.error(pc.red(downloaded.error));
    process.exitCode = 1;
    return;
  }
  for (const warning of downloaded.warnings ?? []) console.error(`${pc.yellow('⚠')} ${warning}`);

  try {
    // El sidecar es metadato de publicación **del origen** (author, license,
    // maturity): copiarlo haría que el índice del adoptante presentara el diseño
    // como publicado por él. Solo se escribe si decide republicarlo.
    fs.rmSync(path.join(downloaded.dir, SIDECAR_FILE), { force: true });

    const spec = copyTree(downloaded.dir, serviceDir, { force: true });
    const manifestFile = path.join(serviceDir, MANIFEST_FILE);
    const basedOn = `${design.service?.name ?? design.slug}@${version}`;
    fs.writeFileSync(manifestFile, stampAdoptedManifest(fs.readFileSync(manifestFile, 'utf8'), { basedOn }));

    console.log(pc.bold(pc.green(`✔ Diseño adoptado: specs/${slug}/ (${basedOn}, sin cambios)`)));
    for (const file of [...spec.copied].sort()) console.log(`  ${pc.dim('•')} specs/${slug}/${file}`);

    const docsFiles = downloaded.docsFiles ?? [];
    if (docsFiles.length > 0) {
      const docsDir = path.join(cwd, 'docs', slug);
      const docs = copyTree(downloaded.docsDir, docsDir, { force: true });
      console.log(`\n${pc.bold(`Derivados: docs/${slug}/`)} ${pc.dim('(al día: nacen con la versión que documentan)')}`);
      for (const file of [...docs.copied].sort()) console.log(`  ${pc.dim('•')} docs/${slug}/${file}`);
    }
    warnIncompleteRegistry(design);

    console.log('\nPróximos pasos:');
    console.log(`  1. Registra el diseño en el índice del workspace: ${pc.cyan('keel index')}`);
    console.log(`  2. Revísalo con ${pc.cyan(`keel describe ${slug}`)} ${pc.dim('(los derivados deben salir al día)')}`);
    console.log(`  3. Genera el servidor: ${pc.cyan(`keel-<tech> build specs/${slug}`)}`);
    console.log(pc.dim(`  Si necesitas cambiarlo, es una evolución: /keel-evolve specs/${slug}.`));
  } finally {
    fs.rmSync(downloaded.root, { recursive: true, force: true });
  }
}

/**
 * El índice sabe cuántos derivados le faltaban al diseño cuando se indexó.
 * Decirlo separa «este diseño no tiene panel» de «el registry está
 * desactualizado», que sin el aviso se ven igual: un archivo que no aparece.
 * Adoptando duele más que derivando, porque el adoptante no va a regenerar nada.
 */
function warnIncompleteRegistry(design) {
  const counts = design.derivatives ?? {};
  const missing = counts.missing ?? 0;
  if (missing === 0) return;
  const total = missing + (counts.fresh ?? 0) + (counts.stale ?? 0) + (counts.unstamped ?? 0);
  console.error(
    `\n${pc.yellow('⚠')} El registry publica ${total - missing} de ${total} derivados de '${design.slug}': ${missing} no existía(n) al indexarlo.`
  );
  console.error(`  ${pc.dim('Tendrás que generarlos tú (/keel-docs, /keel-integrate) o pedir al mantenedor que reindexe con `keel index`.')}`);
}
