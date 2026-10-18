import assert from 'node:assert/strict';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

function parseVersion(version) {
    const match = version.match(semver);
    assert.ok(match, '版本必须是有效 SemVer，不使用构建标识');
    return { core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') };
}

export function releaseChannel(version) {
    return parseVersion(version).prerelease ? 'dev' : 'release';
}

export function checkRelease(version, tag, actualRepository, expectedRepository) {
    parseVersion(version);
    assert.equal(tag, `v${version}`, '标签必须与 package.json 版本一致');
    assert.equal(actualRepository?.toLowerCase(), expectedRepository.toLowerCase(), '请先将 metadata.mjs 改为实际分发仓库');
}

export function checkUpgrade(version, metadata) {
    const oldVersion = metadata.match(/^\/\/\s*@version[\t ]+(\S+)/m)?.[1];
    assert.ok(oldVersion, '线上元数据缺少版本号');
    const next = parseVersion(version);
    const previous = parseVersion(oldVersion);
    assert.equal(releaseChannel(version), releaseChannel(oldVersion), '拒绝混用开发与稳定更新通道');
    const compare = (left, right) => left === right ? 0 : left > right ? 1 : -1;
    let order = 0;
    for (let index = 0; index < 3 && !order; index++) order = compare(next.core[index], previous.core[index]);
    if (!order && next.prerelease && previous.prerelease) {
        for (let index = 0; index < Math.max(next.prerelease.length, previous.prerelease.length) && !order; index++) {
            const left = next.prerelease[index];
            const right = previous.prerelease[index];
            if (left === undefined || right === undefined) {
                order = left === right ? 0 : left === undefined ? -1 : 1;
            } else {
                const leftNumeric = /^\d+$/.test(left);
                const rightNumeric = /^\d+$/.test(right);
                order = leftNumeric && rightNumeric ? compare(BigInt(left), BigInt(right))
                    : leftNumeric !== rightNumeric ? (leftNumeric ? -1 : 1) : compare(left, right);
            }
        }
    }
    assert.ok(order >= 0, '拒绝降低固定安装地址的版本');
}
