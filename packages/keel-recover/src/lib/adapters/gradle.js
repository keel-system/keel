import { evidence } from '../repo.js';
import { stripComments } from '../source-text.js';
import { repositoryRisks, serverOf, springBoot } from './java-common.js';

// Adaptador Java/Gradle: build.gradle (o .kts), gradle.properties, settings y el wrapper. El build
// de Gradle es un programa, no un documento: aquí se leen solo las formas declarativas habituales,
// y lo que no casa con ninguna no se adivina.

const BUILD_FILES = ['build.gradle', 'build.gradle.kts'];

export function detect(repo) {
  return BUILD_FILES.some((f) => repo.has(f));
}

const CONFIGURATIONS =
  /^(implementation|api|compile|compileOnly|runtime|runtimeOnly|annotationProcessor|providedCompile|providedRuntime|testImplementation|testCompile|testRuntime|testRuntimeOnly|testCompileOnly|developmentOnly|kapt)$/;

export function read(repo) {
  const file = BUILD_FILES.find((f) => repo.has(f));
  const raw = repo.text(file) ?? '';
  const lines = stripComments(raw).split(/\r?\n/);
  const ev = (...ns) => evidence(file, ns);

  // Variables: gradle.properties, `ext { x = '…' }`, `ext.x = …`, `def x = …`, `val x = …`.
  const vars = new Map();
  for (const l of repo.lines('gradle.properties') ?? []) {
    const m = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(l);
    if (m && !l.trim().startsWith('#')) vars.set(m[1], m[2]);
  }
  lines.forEach((l) => {
    const m = /^\s*(?:ext\.|def\s+|val\s+|set\(\s*["'])?([A-Za-z_]\w*)["']?\s*(?:,|=)\s*["']([^"']*)["']\s*\)?\s*$/.exec(l);
    if (m) vars.set(m[1], m[2]);
  });
  const resolve = (s) => (s == null ? s : s.replace(/\$\{?([A-Za-z_][\w.]*)\}?/g, (m, k) => (vars.has(k) ? vars.get(k) : m)));

  const declarations = [];
  const libraries = [];
  const repositories = [];
  let boot = null;
  let war = null;
  let baseName = null;

  lines.forEach((l, i) => {
    const n = i + 1;
    // Lenguaje
    let m = /\b(sourceCompatibility|targetCompatibility)\s*=\s*(?:JavaVersion\.VERSION_)?["']?([\d._]+)["']?/.exec(l);
    if (m) declarations.push({ what: 'language', name: 'java', version: m[2].replace(/_/g, '.'), via: `gradle ${m[1]}`, evidence: ev(n) });
    m = /languageVersion(?:\.set\(|\s*=\s*|\s+)JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(l);
    if (m) declarations.push({ what: 'language', name: 'java', version: m[1], via: 'gradle toolchain', evidence: ev(n) });

    // Spring Boot y empaquetado
    m = /id\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s+version\s+["']([^"']+)["']/.exec(l);
    if (m) boot = { version: resolve(m[1]), evidence: ev(n) };
    m = /["']org\.springframework\.boot:spring-boot-gradle-plugin:([^"']+)["']/.exec(l);
    if (m && !boot) boot = { version: resolve(m[1]), evidence: ev(n) };
    if (/apply\s+plugin\s*:\s*["']war["']|\bid\s*\(?\s*["']war["']|^\s*war\s*$/.test(l)) war = n;
    m = /\b(?:archiveBaseName|baseName|archivesBaseName)(?:\.set\(|\s*=\s*)\s*["']([^"']+)["']/.exec(l);
    if (m && !baseName) baseName = { name: resolve(m[1]), line: n };

    // Repositorios
    for (const [re, id, url] of [
      [/\bjcenter\(\)/, 'jcenter', 'https://jcenter.bintray.com'],
      [/\bmavenCentral\(\)/, 'mavenCentral', 'https://repo.maven.apache.org/maven2'],
      [/\bgoogle\(\)/, 'google', 'https://maven.google.com'],
      [/\bmavenLocal\(\)/, 'mavenLocal', null],
    ]) {
      if (re.test(l)) repositories.push({ id, url, for: 'dependencies', evidence: ev(n), risks: repositoryRisks(url ?? '') });
    }
    m = /\burl\s*(?:=\s*)?(?:uri\()?\s*["']([^"']+)["']|\bmaven\s*\(\s*["']([^"']+)["']\s*\)/.exec(l);
    if (m) {
      const url = resolve(m[1] ?? m[2]);
      if (!/services\.gradle\.org/.test(url)) repositories.push({ id: null, url, for: 'dependencies', evidence: ev(n), risks: repositoryRisks(url) });
    }

    // Dependencias: 'g:a:v', g:a:v en paréntesis o el mapa group:/name:/version:
    m = /^\s*(\w+)\s*\(?\s*["']([^"':\s]+):([^"':\s]+)(?::([^"'\s]+))?["']/.exec(l);
    if (m && CONFIGURATIONS.test(m[1])) {
      libraries.push({ id: `${m[2]}:${m[3]}`, version: m[4] ? resolve(m[4]) : null, scope: /^test/.test(m[1]) ? 'test' : 'main', evidence: ev(n) });
    } else {
      m = /^\s*(\w+)\s*\(?\s*group\s*:\s*["']([^"']+)["']\s*,\s*name\s*:\s*["']([^"']+)["'](?:\s*,\s*version\s*:\s*["']([^"']+)["'])?/.exec(l);
      if (m && CONFIGURATIONS.test(m[1])) {
        libraries.push({ id: `${m[2]}:${m[3]}`, version: m[4] ? resolve(m[4]) : null, scope: /^test/.test(m[1]) ? 'test' : 'main', evidence: ev(n) });
      }
    }
  });

  const settingsFile = ['settings.gradle', 'settings.gradle.kts'].find((f) => repo.has(f));
  let rootName = null;
  if (settingsFile) {
    const sl = repo.lines(settingsFile);
    const i = sl.findIndex((l) => /rootProject\.name\s*=/.test(l));
    if (i >= 0) rootName = { name: /["']([^"']+)["']/.exec(sl[i])?.[1] ?? null, evidence: evidence(settingsFile, [i + 1]) };
  }
  const packaging = {
    kind: war ? 'war' : 'jar',
    name: baseName ? baseName.name : rootName ? rootName.name : null,
    evidence: [war || baseName ? ev(...[war, baseName?.line].filter(Boolean)) : null, !baseName && rootName ? rootName.evidence : null]
      .filter(Boolean)
      .join('; ') || file,
  };

  const wrapper = gradleWrapper(repo);
  return {
    stack: 'gradle',
    language: 'java',
    declarations: [...declarations, ...(wrapper.declaration ? [wrapper.declaration] : [])],
    build: {
      tool: 'gradle',
      wrapper: wrapper.present,
      version: wrapper.version,
      evidence: wrapper.present ? wrapper.evidence : `${file} (sin gradlew)`,
    },
    framework: springBoot(boot),
    packaging,
    server: serverOf(libraries, boot, packaging.kind),
    repositories,
    libraries,
  };
}

function gradleWrapper(repo) {
  const props = 'gradle/wrapper/gradle-wrapper.properties';
  const present = repo.has('gradlew') || repo.has(props);
  if (!repo.has(props)) return { present, version: null, evidence: present ? 'gradlew' : null };
  const lines = repo.lines(props);
  const i = lines.findIndex((l) => /^distributionUrl\s*=/.test(l));
  const m = i >= 0 ? /gradle-([\d.]+(?:-rc-\d+)?)-(?:bin|all)\.zip/.exec(lines[i]) : null;
  const ev = evidence(props, [i + 1]);
  return {
    present,
    version: m ? m[1] : null,
    evidence: ev,
    declaration: m ? { what: 'build-tool', name: 'gradle', version: m[1], via: 'gradle-wrapper', evidence: ev } : null,
  };
}
