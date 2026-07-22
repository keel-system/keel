// Wrapper de Gradle (estilo Spring Initializr): scripts + jar vendorizados en
// el paquete; solo el properties se genera, para que la versión salga de la
// constante GRADLE_VERSION.

import path from 'node:path';
import { GRADLE_VERSION, wrapperDir } from '../lib/assets.js';

export function generate() {
  const properties = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`;

  return [
    { path: 'gradlew', sourceFile: path.join(wrapperDir, 'gradlew'), executable: true },
    { path: 'gradlew.bat', sourceFile: path.join(wrapperDir, 'gradlew.bat') },
    {
      path: 'gradle/wrapper/gradle-wrapper.jar',
      sourceFile: path.join(wrapperDir, 'gradle', 'wrapper', 'gradle-wrapper.jar')
    },
    { path: 'gradle/wrapper/gradle-wrapper.properties', content: properties }
  ];
}
