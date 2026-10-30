'use strict';

/* ============================================================
 *  MCP 客户端骨架（G12）
 * ==========================================================
 *  默认关；不拉 @modelcontextprotocol/sdk（无 server 时零依赖）。
 *  行为约定：
 *    · enabled=false → list/call 一律空失败
 *    · 工具调用必须逐条授权（grants["serverId:toolName"]=true）
 *    · 接真 server 前 callTool 只返回 not-connected（防误开）
 * ========================================================== */

let getCfg = () => ({ enabled: false, servers: [], grants: {} });

function configureMcp({ getCfg: gc } = {}) {
  if (typeof gc === 'function') getCfg = gc;
}

function cfgOf() {
  const c = getCfg() || {};
  return {
    enabled: !!c.enabled,
    servers: Array.isArray(c.servers) ? c.servers : [],
    grants: c.grants && typeof c.grants === 'object' ? c.grants : {}
  };
}

function isEnabled() {
  return cfgOf().enabled;
}

function grantKey(serverId, toolName) {
  return `${String(serverId || '').trim()}:${String(toolName || '').trim()}`;
}

function listServers() {
  if (!isEnabled()) return [];
  return cfgOf().servers
    .filter((s) => s && (s.id || s.name))
    .map((s) => ({
      id: String(s.id || s.name),
      name: String(s.name || s.id || ''),
      command: String(s.command || '')
    }));
}

/** 骨架阶段不连进程：始终空表。接 SDK 后在此 listTools。 */
function listTools(/* serverId */) {
  if (!isEnabled()) return [];
  return [];
}

function isGranted(serverId, toolName) {
  const g = cfgOf().grants;
  return g[grantKey(serverId, toolName)] === true;
}

/** @returns {{ key: string, granted: true }} 给 patchConfig 用 */
function grant(serverId, toolName) {
  return { key: grantKey(serverId, toolName), granted: true };
}

/**
 * @returns {Promise<{ ok: boolean, error?: string, content?: unknown }>}
 */
async function callTool(serverId, toolName, _args) {
  if (!isEnabled()) return { ok: false, error: 'mcp-disabled' };
  if (!String(serverId || '').trim() || !String(toolName || '').trim()) {
    return { ok: false, error: 'bad-args' };
  }
  if (!isGranted(serverId, toolName)) return { ok: false, error: 'not-authorized' };
  /* 骨架：已授权也不真连 —— 避免默认关以外的误执行面。 */
  return { ok: false, error: 'not-connected' };
}

module.exports = {
  configureMcp,
  isEnabled,
  listServers,
  listTools,
  isGranted,
  grant,
  grantKey,
  callTool
};
