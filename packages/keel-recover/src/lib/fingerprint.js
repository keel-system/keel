import { cmp, cmpEvidence, gitSource, openRepo } from './repo.js';
import { collectDeclarations } from './declarations.js';
import { readStacks } from './stacks.js';

// Paso 0a: la huella del runtime del legacy. Determinista y sin red: lee el repo y nada más. El
// resultado es `runtime.yaml`, y cada hecho lleva su `archivo:línea`.
//
// Una versión rara vez la dice un solo sitio. Se recogen TODAS las declaraciones (archivo de
// build, archivos de versión, Dockerfiles, CI, compose, scripts) y se elige una con una regla
// fija; las que discrepan no se tiran: van en `declarations` con `consistent: false`, porque esa
// discrepancia es justo lo que el juez (0f) tiene que cruzar.

// Fuerza de cada fuente, de más a menos. El archivo de build fija el objetivo de compilación, que
// es la versión del lenguaje que el código exige; la CI dice con qué se construía.
const RANK = [
  'maven maven.compiler.release',
  'maven-compiler-plugin release',
  'gradle toolchain',
  'maven java.version',
  'maven maven.compiler.source',
  'maven maven.compiler.target',
  'maven-compiler-plugin source',
  'maven-compiler-plugin target',
  'gradle sourceCompatibility',
  'gradle targetCompatibility',
  'maven-wrapper',
  'gradle-wrapper',
  'nvmrc',
  'node-version',
  'tool-versions',
  'volta',
  'engines',
  'dockerfile',
  'circleci',
  'github-actions',
  'gitlab-ci',
  'travis',
  'bitbucket',
  'compose',
  'script',
];

// Archivos cuyo último cambio fecha las dependencias.
const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'];

function rankOf(d) {
  const r = RANK.indexOf(d.via);
  return (r === -1 ? RANK.length : r) + (d.testOnly ? RANK.length : 0);
}

const EXACT = /^v?\d+(\.\d+){0,3}$/;

function normalized(name, version) {
  const v = String(version).replace(/^v/, '');
  return name === 'java' ? v.replace(/^1\.(?=\d)/, '') : v;
}

function major(name, version) {
  return normalized(name, version).split('.')[0];
}

/**
 * Elige la versión entre declaraciones: la fuente más fuerte fija la versión mayor, y dentro de
 * ella gana la más específica (`8` y `8.5.0` dicen lo mismo, y `8.5.0` dice más). Un rango
 * (`>=6`, `lts/*`) se declara pero no se elige.
 */
export function chooseVersion(name, decls) {
  const exact = decls.filter((d) => d.version && EXACT.test(String(d.version))).sort((a, b) => rankOf(a) - rankOf(b) || cmpEvidence(a.evidence, b.evidence));
  if (exact.length === 0) return { version: null, evidence: null, consistent: true };
  const top = major(name, exact[0].version);
  const group = exact.filter((d) => major(name, d.version) === top);
  let chosen = group[0];
  for (const d of group) {
    if (normalized(name, d.version).split('.').length > normalized(name, chosen.version).split('.').length) chosen = d;
  }
  return {
    version: String(chosen.version),
    evidence: chosen.evidence,
    consistent: exact.every((d) => major(name, d.version) === top),
  };
}

const declOut = (d) => ({
  version: d.version == null ? null : String(d.version),
  via: d.via,
  ...(d.image ? { image: d.image } : {}),
  ...(d.note ? { note: d.note } : {}),
  evidence: d.evidence,
});

export function fingerprint(root) {
  const repo = openRepo(root);
  const found = collectDeclarations(repo);
  const stacks = readStacks(repo);
  const testDockerfiles = new Set(found.dockerfiles.filter((d) => d.role === 'test').map((d) => d.path));
  const all = found.declarations.map((d) =>
    d.via === 'dockerfile' && testDockerfiles.has(d.evidence.split(':')[0]) ? { ...d, testOnly: true } : d
  );

  const doc = { kind: 'runtime', schema: 1 };
  const source = gitSource(repo.root, BUILD_FILES.filter((f) => repo.has(f)));
  if (source) doc.source = source;
  doc.stacks = stacks.map((s) => s.stack);

  const primary = stacks[0] ?? null;
  if (!primary) {
    doc.unsupported = 'ningún adaptador reconoce el repo (Maven, Gradle o Node): sin archivo de build no hay huella que leer';
  } else {
    const lang = primary.language;
    const decls = [...primary.declarations.filter((d) => d.what === 'language'), ...all.filter((d) => d.what === 'language' && d.name === lang)].sort(
      (a, b) => rankOf(a) - rankOf(b) || cmpEvidence(a.evidence, b.evidence)
    );
    const chosen = chooseVersion(lang, decls);
    doc.language = {
      name: lang,
      version: chosen.version,
      evidence: chosen.evidence,
      consistent: chosen.consistent,
      declarations: decls.map(declOut),
    };

    if (primary.language === 'java') {
      const toolDecls = [...primary.declarations, ...all].filter((d) => d.what === 'build-tool' && d.name === primary.build.tool).sort(
        (a, b) => rankOf(a) - rankOf(b) || cmpEvidence(a.evidence, b.evidence)
      );
      const tool = chooseVersion(primary.build.tool, toolDecls);
      doc.build = {
        tool: primary.build.tool,
        wrapper: primary.build.wrapper,
        version: tool.version,
        evidence: primary.build.wrapper ? primary.build.evidence : tool.evidence ?? primary.build.evidence,
        ...(toolDecls.length ? { declarations: toolDecls.map(declOut) } : {}),
      };
      doc.framework = primary.framework;
      doc.packaging = primary.packaging;
      doc.server = primary.server;
      doc.repositories = primary.repositories;
      if (primary.modules) doc.modules = primary.modules;
    } else {
      doc.engines = primary.engines;
      doc.package_manager = primary.packageManager;
      doc.lockfiles = primary.lockfiles;
      doc.framework = primary.framework;
      doc.entrypoint = primary.entrypoint;
      doc.registries = primary.registries;
    }
    if (stacks.length > 1) doc.other_stacks = stacks.slice(1).map((s) => s.stack);
  }

  doc.dockerfiles = found.dockerfiles;
  doc.ci = found.ci;
  doc.services = all
    .filter((d) => d.what === 'service')
    .map((d) => ({
      tech: d.name,
      version: d.version ?? null,
      image: d.image ?? null,
      pinned: Boolean(d.pinned),
      via: d.via,
      ...(d.alias ? { alias: d.alias } : {}),
      ...(d.note ? { note: d.note } : {}),
      evidence: d.evidence,
    }))
    .sort((a, b) => cmp(a.tech, b.tech) || cmpEvidence(a.evidence, b.evidence));
  return doc;
}
