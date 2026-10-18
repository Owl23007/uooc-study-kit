import { readFileSync } from 'node:fs';
import { pkg } from './metadata.mjs';
import { checkUpgrade } from './release-policy.mjs';

// 防止更新通道混用或补发的旧标签覆盖较新版本
checkUpgrade(pkg.version, readFileSync(process.argv[2], 'utf8'));
