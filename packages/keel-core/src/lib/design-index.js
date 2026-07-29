// Índice de los diseños de un workspace: tabla legible + índice máquina.
//
// Un workspace con varios diseños (y, en un registry de la comunidad, varias
// variantes del mismo problema) necesita una portada que diga qué hay dentro.
// Esa portada se genera: escribirla a mano garantiza que miente en cuanto
// alguien versiona un diseño.
//
// El índice es una proyección pura de lo que ya saben summarizeService() (qué
// contiene cada diseño) y listDerivatives() (qué derivados existen y si están
// al día), más un sidecar opcional `design.yaml` con los metadatos de
// publicación que no caben en el DSL (familia, variante, madurez, tags).
//
// Determinismo: el índice no lleva marcas de tiempo ni rutas absolutas. Dos
// ejecuciones sobre el mismo workspace producen bytes idénticos, que es lo que
// hace posible `keel index --check` como puerta de CI.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import { packageVersion, schemaPathFor, supportedDsl } from './assets.js';
import { MANIFEST_FILE } from './loader.js';
import { summarizeService } from './summarize-service.js';
import { listDerivatives } from './derivatives.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export const SIDECAR_FILE = 'design.yaml';
export const INDEX_FILE = 'index.json';
export const README_FILE = 'README.md';
export const MARKER_START = '<!-- keel:servicios:start -->';
export const MARKER_END = '<!-- keel:servicios:end -->';

// Versión del formato de index.json, para que un consumidor (keel registry)
// pueda rechazar un índice que no entiende en vez de malinterpretarlo.
export const INDEX_SCHEMA_VERSION = 1;

const EMPTY_TABLE =
  '_Aún no hay servicios diseñados. Cierra un diseño con `/keel-design specs/<servicio>` para poblar esta tabla._';

// De más maduro a menos: ordena las variantes dentro de una familia y decide
// cuál representa a la familia en la tabla principal.
const MATURITY_ORDER = { reference: 0, stable: 1, draft: 2 };
const MATURITY_LABEL = { reference: 'referencia', stable: 'estable', draft: 'borrador' };

function readSidecarSchema() {
  return JSON.parse(fs.readFileSync(schemaPathFor('design'), 'utf8'));
}

function buildSidecarValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(readSidecarSchema());
}

/**
 * Errores de Ajv en una línea accionable. El `message` a secas no basta:
 * `additionalProperties` no dice qué propiedad sobra y `enum` no dice qué
 * valores acepta — eso vive en `params`.
 */
function describeAjvErrors(errors) {
  return errors
    .map((entry) => {
      const where = entry.instancePath || '/';
      if (entry.keyword === 'additionalProperties') {
        return `${where} propiedad no reconocida '${entry.params.additionalProperty}'`;
      }
      if (entry.keyword === 'enum') {
        return `${where} ${entry.message} (${entry.params.allowedValues.join(', ')})`;
      }
      return `${where} ${entry.message}`;
    })
    .join('; ');
}

/** Slugs de `specs/` que contienen un manifiesto, en orden alfabético. */
function designSlugs(cwd) {
  const specsDir = path.join(cwd, 'specs');
  let entries;
  try {
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(specsDir, name, MANIFEST_FILE)))
    .sort();
}

/**
 * Lee y valida el sidecar. Devuelve { metadata, errors }: un sidecar inválido
 * no tumba el índice, se reporta y el diseño entra sin metadatos (así el
 * problema es visible en el índice en vez de desaparecer con él).
 */
function readSidecar(dir, slug, validate) {
  const file = path.join(dir, SIDECAR_FILE);
  if (!fs.existsSync(file)) return { metadata: null, errors: [] };

  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { metadata: null, errors: [`specs/${slug}/${SIDECAR_FILE}: YAML inválido — ${error.message}`] };
  }

  if (!validate(doc)) {
    return {
      metadata: null,
      errors: [`specs/${slug}/${SIDECAR_FILE}: no cumple design.schema.json — ${describeAjvErrors(validate.errors)}`]
    };
  }

  return { metadata: doc, errors: [] };
}

/** Recuentos por capa: lo que hace comparable un diseño con otro de un vistazo. */
function countsOf(summary) {
  const counts = {};
  if (summary.domain) {
    counts.entities = summary.domain.entities.length;
    counts.types = summary.domain.typeCount;
    counts.aggregates = summary.domain.aggregates.length;
  }
  if (summary.useCases) {
    counts.operations = summary.useCases.operations.length;
    counts.commands = summary.useCases.operations.filter((op) => op.kind === 'command').length;
    counts.queries = summary.useCases.operations.filter((op) => op.kind === 'query').length;
  }
  if (summary.api) counts.endpoints = summary.api.endpoints.length;
  if (summary.security) {
    counts.roles = summary.security.roles.length;
    counts.serviceClients = summary.security.serviceClients.length;
  }
  if (summary.messaging) {
    counts.publishedEvents = summary.messaging.published.length;
    counts.subscriptions = summary.messaging.subscriptions.length;
  }
  if (summary.httpClients) counts.httpClients = summary.httpClients.clients.length;
  if (summary.dependencies) counts.dependencies = summary.dependencies.dependencies.length;
  if (summary.persistence) counts.persistedEntities = summary.persistence.entities.length;
  if (summary.storage) counts.buckets = summary.storage.buckets.length;
  return counts;
}

/**
 * Archivos que componen el diseño, relativos a la raíz del workspace y en
 * POSIX. Es lo que permite a un consumidor remoto descargar un diseño suelto
 * sin clonar el repo ni descomprimir un tarball.
 */
function filesOf({ slug, layers, metadata, derivatives }) {
  const files = [`specs/${slug}/${MANIFEST_FILE}`];
  for (const layer of layers) files.push(`specs/${slug}/${layer}.keel.yaml`);
  if (metadata) files.push(`specs/${slug}/${SIDECAR_FILE}`);
  for (const entry of derivatives) {
    if (entry.exists) files.push(entry.path);
  }
  return files;
}

/**
 * Construye el índice de todos los diseños de un workspace.
 * Objeto puro: sin escrituras, sin consola, sin exitCode.
 *
 * Devuelve { schemaVersion, designs, families, warnings }.
 */
export function buildIndex(cwd = process.cwd()) {
  const validateSidecar = buildSidecarValidator();
  const warnings = [];
  const designs = [];

  for (const slug of designSlugs(cwd)) {
    const dir = path.join(cwd, 'specs', slug);
    const { service, status, layers, summary } = summarizeService(dir);

    if (status.loadFailed) {
      warnings.push(`specs/${slug}: no carga, se omite del índice — ${status.errors.join('; ')}`);
      continue;
    }

    const { metadata, errors } = readSidecar(dir, slug, validateSidecar);
    warnings.push(...errors);

    const family = metadata?.family ?? slug;
    let variant = metadata?.variant ?? null;
    if (family !== slug && !variant) {
      // Sin variante no hay forma de nombrar la fila dentro de su familia:
      // se deduce del slug y se avisa, en vez de dejar la tabla ambigua.
      variant = slug.startsWith(`${family}-`) ? slug.slice(family.length + 1) : slug;
      warnings.push(
        `specs/${slug}/${SIDECAR_FILE}: declara family '${family}' distinta del slug pero no variant — se asume '${variant}'`
      );
    }

    // listDerivatives resuelve docs/<service.name>/, no docs/<slug>/: dos diseños
    // que declaren el mismo service.name compartirían derivados y se pisarían.
    // En un workspace normal el slug y el nombre coinciden; en un registry con
    // variantes es una condición que hay que vigilar.
    if (service.name && service.name !== slug) {
      warnings.push(
        `specs/${slug}: service.name es '${service.name}' y no coincide con el directorio — sus derivados viven en docs/${service.name}/ y colisionarían con otro diseño del mismo nombre`
      );
    }

    const inventory = listDerivatives(dir, { cwd });
    const byId = new Map(inventory.derivatives.map((entry) => [entry.id, entry]));
    const docPath = (id) => (byId.get(id)?.exists ? byId.get(id).path : null);

    designs.push({
      slug,
      family,
      variant,
      service: {
        name: service.name,
        version: service.version,
        dsl: service.dsl,
        domain: service.domain,
        basedOn: service.basedOn,
        description: service.description
      },
      metadata,
      layers: layers.present,
      counts: countsOf(summary),
      status: { ok: status.ok, pending: status.pending.length, errors: status.errorCount },
      derivatives: inventory.counts,
      docs: {
        design: docPath('design'),
        overview: docPath('overview'),
        integration: docPath('integration')
      },
      files: filesOf({ slug, layers: layers.present, metadata, derivatives: inventory.derivatives })
    });
  }

  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    // Procedencia, para que un desajuste entre registry y CLI sea diagnosticable.
    // No forma parte del contrato: indexContract() la excluye (ver ahí el motivo).
    generatedBy: { keelCore: packageVersion(), dsl: [...supportedDsl()] },
    designs,
    families: groupByFamily(designs),
    warnings
  };
}

/**
 * El índice sin su procedencia: lo que de verdad constituye el contrato.
 *
 * `keel index --check` compara por aquí porque `generatedBy` cambia con cada
 * release de keel-core, y si contara, cada actualización de la CLI dejaría en
 * rojo el CI de todos los registries hasta que alguien reindexara. La
 * procedencia informa; el contenido de los diseños obliga.
 */
export function indexContract(index) {
  if (index == null || typeof index !== 'object') return index;
  const { generatedBy, warnings, ...contract } = index;
  return contract;
}

/**
 * Serialización canónica (claves ordenadas) para comparar dos índices por
 * contenido y no por el orden en que se escribieron. Sin esto, reordenar una
 * clave en una versión futura provocaría un fallo espurio de `--check` en el PR
 * de alguien que no ha tocado nada.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Agrupa por familia: familias alfabéticas, y dentro de cada una las variantes
 * de más madura a menos y luego por slug.
 */
export function groupByFamily(designs) {
  const families = new Map();
  for (const design of designs) {
    if (!families.has(design.family)) families.set(design.family, []);
    families.get(design.family).push(design);
  }

  return [...families.keys()]
    .sort()
    .map((name) => ({
      name,
      designs: families
        .get(name)
        .slice()
        .sort((a, b) => {
          const order =
            (MATURITY_ORDER[a.metadata?.maturity] ?? MATURITY_ORDER.draft) -
            (MATURITY_ORDER[b.metadata?.maturity] ?? MATURITY_ORDER.draft);
          return order !== 0 ? order : a.slug.localeCompare(b.slug);
        })
        .map((design) => design.slug)
    }));
}

function cell(value) {
  if (value == null || value === '') return '—';
  return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function maturityCell(design) {
  const maturity = design.metadata?.maturity;
  return maturity ? MATURITY_LABEL[maturity] : '—';
}

/** El resumen del sidecar manda; sin sidecar, la description del manifiesto. */
function summaryCell(design) {
  return cell(design.metadata?.summary ?? design.service.description);
}

function layersCell(design) {
  return design.layers.length > 0 ? `\`${design.layers.join('`, `')}\`` : '—';
}

/**
 * Enlaces a los derivados que existen de verdad; nunca a un archivo ausente.
 * Sale del propio índice (`design.docs`), así que la tabla es función pura del
 * índice y no vuelve a tocar disco.
 */
function docsCell(design) {
  const links = [];
  if (design.docs.design) links.push(`[diseño](${design.docs.design})`);
  if (design.docs.overview) links.push(`[panel](${design.docs.overview})`);
  if (design.docs.integration) links.push(`[integración](${design.docs.integration})`);
  return links.length > 0 ? links.join(' · ') : '—';
}

// Ancla que GitHub genera para un `### <familia> — N variantes`: minúsculas, se
// cae todo lo que no sea alfanumérico, espacio o guion, y cada espacio pasa a
// guion **uno a uno** (no por rachas). Por eso el em dash rodeado de espacios
// deja un guion doble: `notifications--3-variantes`.
function anchorFor(heading) {
  return `#${heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-')}`;
}

/**
 * Renderiza el contenido que va entre los marcadores del README.
 * Familias de un solo diseño ocupan una fila; las que tienen varias variantes
 * ocupan una fila que remite a su propia subtabla, donde se comparan.
 */
export function renderTable(index) {
  if (index.designs.length === 0) return EMPTY_TABLE;

  const bySlug = new Map(index.designs.map((design) => [design.slug, design]));
  const lines = [
    '| Diseño | Dominio | Madurez | Resumen | Capas | Documentación |',
    '|---|---|---|---|---|---|'
  ];
  const sections = [];

  for (const family of index.families) {
    const members = family.designs.map((slug) => bySlug.get(slug));

    if (members.length === 1) {
      const design = members[0];
      lines.push(
        `| [\`${design.slug}\`](specs/${design.slug}/) | ${cell(design.service.domain)} | ${maturityCell(design)} | ${summaryCell(design)} | ${layersCell(design)} | ${docsCell(design)} |`
      );
      continue;
    }

    // La familia ocupa una fila que remite a su subtabla, y la representa su
    // variante más madura: quien hojea el índice ve la familia sin tener que
    // elegir variante todavía.
    const heading = `${family.name} — ${members.length} variantes`;
    const lead = members[0];
    lines.push(
      `| [${family.name}](${anchorFor(heading)}) | ${cell(lead.service.domain)} | ${maturityCell(lead)} | ${summaryCell(lead)} | ${members.length} variantes | ver abajo |`
    );

    sections.push(
      [
        `### ${heading}`,
        '',
        '| Variante | Madurez | Difiere en | Capas | Documentación |',
        '|---|---|---|---|---|',
        ...members.map(
          (design) =>
            `| [\`${design.slug}\`](specs/${design.slug}/) | ${maturityCell(design)} | ${cell(design.metadata?.differsIn ?? design.metadata?.summary ?? design.service.description)} | ${layersCell(design)} | ${docsCell(design)} |`
        )
      ].join('\n')
    );
  }

  return [lines.join('\n'), ...sections].join('\n\n');
}

/**
 * Sustituye el contenido entre los marcadores preservando todo lo demás
 * (introducción y secciones escritas por humanos). Respeta el fin de línea
 * dominante del archivo: si no, `--check` no convergería nunca en un repo con
 * CRLF. Devuelve { text } o { error }.
 */
export function applyMarkers(readme, table) {
  const start = readme.indexOf(MARKER_START);
  const end = readme.indexOf(MARKER_END);

  if (start === -1 || end === -1) {
    return {
      error:
        `${README_FILE} no tiene los marcadores del índice.\n` +
        `  Añade una línea con ${MARKER_START} y otra con ${MARKER_END} donde deba ir la tabla.`
    };
  }
  if (end < start) {
    return { error: `${README_FILE}: ${MARKER_END} aparece antes de ${MARKER_START}.` };
  }

  const eol = readme.includes('\r\n') ? '\r\n' : '\n';
  const block = table.split(/\r?\n/).join(eol);
  const head = readme.slice(0, start + MARKER_START.length);
  const tail = readme.slice(end);

  return { text: `${head}${eol}${block}${eol}${tail}` };
}

/**
 * JSON estable (claves en el orden de construcción, salto final) para diffs limpios.
 *
 * El fin de línea entra por parámetro por el mismo motivo que en applyMarkers:
 * con `core.autocrlf=true`, git deja el archivo en CRLF en el working copy de
 * Windows, y emitir LF a ciegas haría que `--check` no convergiera nunca ahí.
 */
export function renderIndexJson(index, { eol = '\n' } = {}) {
  const { warnings, ...stable } = index;
  const text = `${JSON.stringify(stable, null, 2)}\n`;
  return eol === '\n' ? text : text.split('\n').join(eol);
}

/** Fin de línea dominante de un texto ya existente. */
export function detectEol(text) {
  return typeof text === 'string' && text.includes('\r\n') ? '\r\n' : '\n';
}
