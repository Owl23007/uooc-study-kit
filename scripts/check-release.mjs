import { pkg, repository } from './metadata.mjs';
import { checkRelease, releaseChannel } from './release-policy.mjs';
import { appendFileSync } from 'node:fs';

checkRelease(pkg.version, process.env.GITHUB_REF_NAME, process.env.GITHUB_REPOSITORY, repository);
if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `channel=${releaseChannel(pkg.version)}\nprerelease=${releaseChannel(pkg.version) === 'dev'}\n`);
}
console.log(`发布校验通过：v${pkg.version}`);
