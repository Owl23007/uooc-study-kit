// 敏感配置仅写入油猴隔离存储，权限缺失时拒绝写入页面存储
export const Storage = {
    get(key, fallback = null) {
        try { return GM_getValue(key, fallback); } catch { return fallback; }
    },
    set(key, value) {
        try { GM_setValue(key, value); }
        catch { throw new Error('Tampermonkey 存储不可用，请检查脚本权限'); }
    },
};
