import { evidence } from '../repo.js';
import { at, child, children, parseXml, textOf } from '../xml-lines.js';
import { repositoryRisks, serverOf, springBoot } from './java-common.js';

// Adaptador Java/Maven: lo que el pom.xml (y el wrapper, si lo hay) dicen del runtime.

export function detect(repo) {
  return repo.has('pom.xml');
}

export function read(repo) {
  const file = 'pom.xml';
  const pom = parseXml(repo.text(file) ?? '');
  if (!pom) return { stack: 'maven', language: 'java', unreadable: file };
  const ev = (...nodes) => evidence(file, nodes.filter(Boolean).map((n) => n.line));

  const props = new Map();
  for (const p of child(pom, 'properties')?.children ?? []) props.set(p.name, p);
  const resolve = (value) =>
    value == null ? value : value.replace(/\$\{([^}]+)\}/g, (m, k) => (props.has(k) ? props.get(k).text : m));

  // Versión del lenguaje: las propiedades estándar y el maven-compiler-plugin, por este orden.
  const declarations = [];
  for (const [key, via] of [
    ['maven.compiler.release', 'maven maven.compiler.release'],
    ['java.version', 'maven java.version'],
    ['maven.compiler.source', 'maven maven.compiler.source'],
    ['maven.compiler.target', 'maven maven.compiler.target'],
  ]) {
    if (props.has(key)) declarations.push({ what: 'language', name: 'java', version: resolve(props.get(key).text), via, evidence: ev(props.get(key)) });
  }
  const plugins = children(at(pom, 'build/plugins'), 'plugin');
  for (const plugin of plugins) {
    if (textOf(child(plugin, 'artifactId')) !== 'maven-compiler-plugin') continue;
    for (const k of ['release', 'source', 'target']) {
      const n = at(plugin, `configuration/${k}`);
      if (n) declarations.push({ what: 'language', name: 'java', version: resolve(n.text), via: `maven-compiler-plugin ${k}`, evidence: ev(n) });
    }
  }

  const libraries = [];
  const managed = [];
  for (const dep of children(child(pom, 'dependencies'), 'dependency')) {
    const groupId = textOf(child(dep, 'groupId'));
    const artifactId = textOf(child(dep, 'artifactId'));
    const version = child(dep, 'version');
    const scope = textOf(child(dep, 'scope'));
    libraries.push({
      id: `${groupId}:${artifactId}`,
      version: version ? resolve(version.text) : null,
      scope: scope === 'test' ? 'test' : 'main',
      evidence: ev(child(dep, 'artifactId')),
    });
  }
  for (const dep of children(at(pom, 'dependencyManagement/dependencies'), 'dependency')) {
    managed.push({
      id: `${textOf(child(dep, 'groupId'))}:${textOf(child(dep, 'artifactId'))}`,
      version: resolve(textOf(child(dep, 'version'))),
      evidence: ev(child(dep, 'artifactId')),
    });
  }

  // Spring Boot: el padre, el BOM importado o la versión del plugin.
  const parent = child(pom, 'parent');
  const parentId = parent ? `${textOf(child(parent, 'groupId'))}:${textOf(child(parent, 'artifactId'))}` : null;
  let boot = null;
  if (parentId === 'org.springframework.boot:spring-boot-starter-parent') {
    boot = { version: resolve(textOf(child(parent, 'version'))), evidence: evidence(file, [child(parent, 'artifactId').line, child(parent, 'version').line]) };
  } else {
    const bom = managed.find((m) => m.id === 'org.springframework.boot:spring-boot-dependencies');
    const plugin = plugins.find((p) => textOf(child(p, 'artifactId')) === 'spring-boot-maven-plugin' && child(p, 'version'));
    if (bom) boot = { version: bom.version, evidence: bom.evidence };
    else if (plugin) boot = { version: resolve(textOf(child(plugin, 'version'))), evidence: ev(child(plugin, 'version')) };
  }

  const packagingNode = child(pom, 'packaging');
  const finalName = at(pom, 'build/finalName');
  const artifactId = child(pom, 'artifactId');
  const packaging = {
    kind: packagingNode ? packagingNode.text : 'jar',
    name: finalName ? resolve(finalName.text) : artifactId ? artifactId.text : null,
    evidence: ev(packagingNode, finalName ?? artifactId),
  };

  const repositories = [];
  for (const [group, item, kind] of [
    ['repositories', 'repository', 'dependencies'],
    ['pluginRepositories', 'pluginRepository', 'plugins'],
  ]) {
    for (const r of children(child(pom, group), item)) {
      const url = child(r, 'url');
      repositories.push({
        id: textOf(child(r, 'id')),
        url: url ? resolve(url.text) : null,
        for: kind,
        evidence: evidence(file, [r.line, url?.line].filter(Boolean)),
        risks: repositoryRisks(url ? url.text : ''),
      });
    }
  }

  const wrapper = mavenWrapper(repo);
  const modules = children(child(pom, 'modules'), 'module').map((m) => m.text);

  return {
    stack: 'maven',
    language: 'java',
    declarations: [...declarations, ...(wrapper.declaration ? [wrapper.declaration] : [])],
    build: {
      tool: 'maven',
      wrapper: wrapper.present,
      version: wrapper.version,
      evidence: wrapper.present ? wrapper.evidence : wrapper.evidence ?? `${file} (sin mvnw)`,
    },
    framework: springBoot(boot),
    packaging,
    server: serverOf(libraries, boot, packaging.kind),
    repositories,
    libraries,
    ...(modules.length ? { modules } : {}),
  };
}

function mavenWrapper(repo) {
  const props = '.mvn/wrapper/maven-wrapper.properties';
  // mvnw sin .mvn/wrapper/ no arranca: el script lee de ahí la distribución (medido en shop-api, que trae mvnw y
  // mvnw.cmd pero no el directorio). Un wrapper roto no es un wrapper: el build va con la imagen de Maven.
  if (!repo.has(props)) return { present: false, version: null, evidence: repo.has('mvnw') ? 'mvnw sin .mvn/wrapper/maven-wrapper.properties: el wrapper está roto' : null };
  const present = true;
  const lines = repo.lines(props);
  const i = lines.findIndex((l) => /^distributionUrl\s*=/.test(l));
  const m = i >= 0 ? /apache-maven-([\d.]+)-bin/.exec(lines[i]) : null;
  const ev = evidence(props, [i + 1]);
  return {
    present,
    version: m ? m[1] : null,
    evidence: ev,
    declaration: m ? { what: 'build-tool', name: 'maven', version: m[1], via: 'maven-wrapper', evidence: ev } : null,
  };
}
