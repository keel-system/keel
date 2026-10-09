import { planFixture } from './test/helpers/emitted.js';
const [name, ...paths] = process.argv.slice(2);
const { files } = planFixture(name, { stack: { cache: 'redis', storage: 'minio' } });
for (const f of files) if (paths.some((p) => f.path.includes(p))) console.log(`=== ${f.path}\n${f.content}`);
