'use strict';

/* ============================================================
 *  model profile 自动扫描（G5）
 * ==========================================================
 *
 *  从 cdi3.json + physics3.json 抽出档案骨架：
 *    · 全部参数（id / 显示名 / 组）
 *    · 物理输出表（规矩 35：情绪引擎不能写这些）
 *    · 按常见 Cubism 标准 ID 猜语义通道（MOUTH_OPEN 等）
 *    · 能力覆盖率 + 与物理输出的冲突
 *
 *  纯函数、不碰磁盘/Electron —— verify 与 CLI 都能直接 require。
 *  几何标定（inkTopK 等）仍靠人工实测，这里**不编造**。
 * ========================================================== */

/* 语义通道 → 常见 Cubism 参数 ID（多候选时取第一个在模型里存在的）。 */
const CHANNEL_CANDIDATES = {
  MOUTH_OPEN: ['ParamMouthOpenY'],
  MOUTH_FORM: ['ParamMouthForm'],
  EYE_L: ['ParamEyeLOpen'],
  EYE_R: ['ParamEyeROpen'],
  EYE_L_SMILE: ['ParamEyeLSmile'],
  EYE_R_SMILE: ['ParamEyeRSmile'],
  BROW_L_Y: ['ParamBrowLY'],
  BROW_R_Y: ['ParamBrowRY'],
  BROW_L_X: ['ParamBrowLX'],
  BROW_R_X: ['ParamBrowRX'],
  BROW_L_ANGLE: ['ParamBrowLAngle'],
  BROW_R_ANGLE: ['ParamBrowRAngle'],
  BROW_L_FORM: ['ParamBrowLForm'],
  BROW_R_FORM: ['ParamBrowRForm'],
  CHEEK: ['ParamCheek'],
  ANGLE_X: ['ParamAngleX'],
  ANGLE_Y: ['ParamAngleY'],
  ANGLE_Z: ['ParamAngleZ'],
  BODY_X: ['ParamBodyAngleX'],
  BODY_Y: ['ParamBodyAngleY'],
  BODY_Z: ['ParamBodyAngleZ']
};

function physicsOutputIds(physics) {
  const outs = new Set();
  if (!physics || typeof physics !== 'object') return outs;
  for (const g of physics.PhysicsSettings || []) {
    for (const o of g.Output || []) {
      const id = o?.Destination?.Id;
      if (typeof id === 'string' && id) outs.add(id);
    }
  }
  return outs;
}

function listParameters(cdi) {
  const groups = new Map();
  for (const g of cdi?.ParameterGroups || []) {
    if (g && typeof g.Id === 'string') groups.set(g.Id, String(g.Name || g.Id));
  }
  const out = [];
  for (const p of cdi?.Parameters || []) {
    if (!p || typeof p.Id !== 'string' || !p.Id) continue;
    out.push({
      id: p.Id,
      name: String(p.Name || p.Id),
      groupId: typeof p.GroupId === 'string' ? p.GroupId : '',
      groupName: groups.get(p.GroupId) || ''
    });
  }
  return out;
}

function suggestParamMap(parameters, physicsOuts) {
  const byId = new Set(parameters.map((p) => p.id));
  const suggested = {};
  const skippedPhysics = [];
  for (const [channel, cands] of Object.entries(CHANNEL_CANDIDATES)) {
    let hit = '';
    for (const id of cands) {
      if (!byId.has(id)) continue;
      if (physicsOuts.has(id)) {
        skippedPhysics.push({ channel, id });
        continue;
      }
      hit = id;
      break;
    }
    suggested[channel] = hit;
  }
  return { suggested, skippedPhysics };
}

function coverageOf(suggested) {
  const keys = Object.keys(CHANNEL_CANDIDATES);
  const hit = keys.filter((k) => suggested[k]).length;
  return {
    hit,
    total: keys.length,
    ratio: keys.length ? hit / keys.length : 0,
    missing: keys.filter((k) => !suggested[k])
  };
}

/* 主入口：给已 parse 的 JSON 对象。 */
function scanModelProfile({ cdi, physics } = {}) {
  const parameters = listParameters(cdi);
  const physicsOuts = physicsOutputIds(physics);
  const { suggested, skippedPhysics } = suggestParamMap(parameters, physicsOuts);
  const coverage = coverageOf(suggested);
  const conflicts = Object.entries(suggested)
    .filter(([, id]) => id && physicsOuts.has(id))
    .map(([channel, id]) => ({ channel, id }));

  return {
    paramCount: parameters.length,
    parameters,
    physicsOutputs: [...physicsOuts].sort(),
    suggestedParam: suggested,
    skippedPhysics,
    coverage,
    conflicts,
    /* 骨架草稿：几何留空，人工标定；param 已填建议值。 */
    skeleton: {
      name: '',
      model: {
        label: '',
        url: '',
        petScale: null,
        headPadRatio: null,
        inkTopK: null,
        inkH: null,
        inkW: null,
        inkCxK: null,
        keepLoopGroups: [],
        fadeOverride: {},
        motionSlots: {
          thinking: '', working: '', success: '', error: '', drag: '', walk: ''
        }
      },
      param: { ...suggested }
    }
  };
}

module.exports = {
  CHANNEL_CANDIDATES,
  physicsOutputIds,
  listParameters,
  suggestParamMap,
  coverageOf,
  scanModelProfile
};
