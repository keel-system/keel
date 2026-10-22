import * as maven from './adapters/maven.js';
import * as gradle from './adapters/gradle.js';
import * as node from './adapters/node.js';

// Adaptadores por tecnología del legacy, en orden de preferencia: si un repo trae pom.xml y
// build.gradle, manda el primero; si trae además un package.json (un frontend al lado), el
// servicio sigue siendo el Java y el resto se declara.
export const ADAPTERS = [maven, gradle, node];

/** Stacks presentes en el repo, cada uno con lo que su adaptador lee. */
export function readStacks(repo) {
  return ADAPTERS.filter((a) => a.detect(repo)).map((a) => a.read(repo));
}
