import path from 'node:path';
import { loadService } from 'keel-core';
import { planService } from './src/scaffold/index.js';
import { checkSupportedFeatures } from './src/lib/supported-features.js';
for (const name of ['inspection-reports', 'job-dispatch-mongo', 'notification-mailer-mongo']) {
  const { manifest, layers } = loadService(path.resolve('../../fixtures/designs', name));
  if (name === 'inspection-reports') { delete layers.messaging; delete manifest.layers.messaging; }
  const { errors, warnings } = checkSupportedFeatures(manifest, layers);
  console.log('==', name, 'errores:', errors.length, errors.map(e=>e.slice(0,90)));
  if (errors.length) continue;
  const { files, model } = planService({ manifest, layers, workspace: path.resolve('../../fixtures') });
  console.log(files.filter(f => /persistence|export-indexes|db.yaml/.test(f.path)).map(f => f.path).join('\n'));
  console.log('avisos:', model.warnings);
  const adapter = files.find(f => f.path.endsWith('inspection-report-repository-impl.ts'));
  console.log(adapter.content);
}
