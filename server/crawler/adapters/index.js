'use strict';
/**
 * 适配器注册表。
 * 每个题源对应一个适配器；新增题源只需在这里挂一个实现。
 */

const wjx = require('./wjx');
const generic = require('./generic');

const REGISTRY = new Map([
  [wjx.key, wjx],
  [generic.key, generic]
]);

function get(key) {
  if (!key) return null;
  return REGISTRY.get(String(key)) || null;
}

function list() {
  return Array.from(REGISTRY.values()).map(a => ({
    key: a.key,
    name: a.name,
    homepage: a.homepage || null,
    reliability: a.reliability || 'unknown',
    note: a.note || '',
    defaultConfig: a.DEFAULT_CONFIG || {}
  }));
}

module.exports = { get, list, REGISTRY };
