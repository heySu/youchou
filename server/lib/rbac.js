'use strict';
/**
 * 权限矩阵。
 *
 * 设计原则：
 * 1. 接口只声明「需要哪个权限点」，不判断角色。角色是权限的打包，不是判断依据。
 *    这样加一个角色不用改任何路由，改权限也不用满仓库找 if (role === 'admin')。
 * 2. 权限点命名统一为 `资源:动作`，动作按破坏力递增：view < review/run < manage。
 * 3. 最小权限：审核员不能打款，财务不能改风控，运营不能动成员。
 *    职责分离（SoD）——一个人能既改佣金又能打款，就等于没有内控。
 */

const PERMISSIONS = {
  'dashboard:view': '查看经营概览',

  'source:view': '查看题源配置',
  'source:manage': '启停题源、查看密钥',

  'crawl:view': '查看抓取任务与日志',
  'crawl:run': '触发抓取',

  'offer:view': '查看问卷库',
  'offer:review': '上架 / 忽略抓取任务',

  'commission:view': '查看佣金单',
  'commission:review': '复核佣金（通过 / 驳回）',
  'settle:run': '执行结算解冻',

  'risk:view': '查看风控命中',
  'risk:manage': '调整风控规则',

  'postback:view': '查看回调与对账',

  'withdrawal:view': '查看提现单',
  'withdrawal:pay': '提现打款',

  'member:view': '查看成员',
  'member:manage': '修改成员角色与状态',

  'audit:view': '查看操作审计'
};

/**
 * 角色 = 权限包。
 * order 决定后台成员列表里的排序，level 用于「不能操作同级或更高」的判定。
 */
const ROLES = {
  user: {
    label: '普通用户',
    level: 0,
    perms: []
  },
  operator: {
    label: '运营',
    level: 20,
    perms: [
      'dashboard:view',
      'source:view', 'source:manage',
      'crawl:view', 'crawl:run',
      'offer:view', 'offer:review',
      'commission:view'
    ]
  },
  reviewer: {
    label: '审核员',
    level: 30,
    perms: [
      'dashboard:view',
      'source:view',
      'crawl:view',
      'offer:view',
      'commission:view', 'commission:review',
      'risk:view',
      'postback:view',
      'withdrawal:view'
    ]
  },
  finance: {
    label: '财务',
    level: 30,
    perms: [
      'dashboard:view',
      'commission:view',
      'settle:run',
      'postback:view',
      'withdrawal:view', 'withdrawal:pay'
    ]
  },
  admin: {
    label: '超级管理员',
    level: 90,
    perms: ['*']
  }
};

const ROLE_KEYS = Object.keys(ROLES);
/** 能登录后台的角色 */
const BACKEND_ROLES = ROLE_KEYS.filter(r => r !== 'user');

function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

/** 角色对应的权限点数组；admin 返回全部（展开成具体清单，前端才好渲染） */
function permissionsOf(role) {
  const def = ROLES[role];
  if (!def) return [];
  if (def.perms.includes('*')) return Object.keys(PERMISSIONS);
  return def.perms.slice();
}

function hasPermission(user, perm) {
  if (!user) return false;
  // 被禁用的账号即使持有未过期的令牌也不算数
  if (user.status && user.status !== 'active') return false;
  const def = ROLES[user.role];
  if (!def) return false;
  if (def.perms.includes('*')) return true;
  return def.perms.includes(perm);
}

function levelOf(role) {
  const def = ROLES[role];
  return def ? def.level : -1;
}

/** 是否能登录后台（普通用户不行） */
function canUseBackend(role) {
  return BACKEND_ROLES.includes(role);
}

module.exports = {
  PERMISSIONS,
  ROLES,
  ROLE_KEYS,
  BACKEND_ROLES,
  isValidRole,
  permissionsOf,
  hasPermission,
  levelOf,
  canUseBackend
};
