import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { metadata, pkg, repository } from '../scripts/metadata.mjs';
import { checkRelease, checkUpgrade, releaseChannel } from '../scripts/release-policy.mjs';

test('发布标签必须与版本和实际仓库一致', () => {
    assert.doesNotThrow(() => checkRelease('0.1.0', 'v0.1.0', repository, repository));
    assert.throws(() => checkRelease('0.1.0', 'v0.0.1', repository, repository), /标签/);
    assert.throws(() => checkRelease('0.1.0', 'v0.1.0', 'someone/other', repository), /仓库/);
});

test('稳定地址允许升级和同版本重试，拒绝降级与损坏元数据', () => {
    for (const version of ['0.0.1', '0.1.0']) {
        assert.doesNotThrow(() => checkUpgrade('0.1.0', `// @version ${version}`));
    }
    for (const version of ['999.0.0', 'invalid', '0.1.0-dev']) {
        assert.throws(() => checkUpgrade('0.1.0', `// @version ${version}`));
    }
});

test('预发布使用独立通道并允许标签发布', () => {
    assert.doesNotThrow(() => checkRelease('0.1.0-dev', 'v0.1.0-dev', repository, repository));
    assert.equal(releaseChannel('0.1.0-dev'), 'dev');
    assert.equal(releaseChannel('0.1.0'), 'release');
    assert.throws(() => checkUpgrade('0.1.0-dev', '// @version 0.0.1'), /通道/);
    assert.match(metadata(), new RegExp(`/${releaseChannel(pkg.version)}/uooc-study-plugin.meta.js`));
    const result = spawnSync(process.execPath, ['scripts/check-release.mjs'], {
        env: { ...process.env, GITHUB_REF_NAME: `v${pkg.version}`, GITHUB_REPOSITORY: repository },
    });
    assert.equal(result.status, 0, result.stderr.toString());
});

test('开发通道遵循 SemVer 预发布顺序并拒绝降级', () => {
    for (const [next, previous] of [
        ['0.1.0-dev', '0.1.0-dev'], ['0.1.0-dev.10', '0.1.0-dev.2'],
        ['0.1.0-dev.1', '0.1.0-dev'], ['0.2.0-alpha', '0.1.0-dev'],
        ['0.1.0-beta', '0.1.0-alpha'], ['0.1.0-dev.x', '0.1.0-dev.1'],
    ]) {
        assert.doesNotThrow(() => checkUpgrade(next, `// @version ${previous}`));
        if (next !== previous) assert.throws(() => checkUpgrade(previous, `// @version ${next}`), /降低/);
    }
    for (const invalid of ['01.1.0', '0.1.0-dev.01', '0.1.0-', '0.1.0+build', 'invalid']) {
        assert.throws(() => checkRelease(invalid, `v${invalid}`, repository, repository), /SemVer/);
    }
});
