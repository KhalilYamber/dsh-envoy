// dsh-cancel.js —— 止损工具（dsh_cancel）
// 协议细节以 DSH 官方实现与实测行为为准（DSH 0.1.0-rc.6）。
// 流程：取单例 runner（无则「无需取消」）→ 定位目标任务（缺省取消唯一运行任务；
//       多个在跑时须传 sessionId/opId 指定）→ runner.cancelRequested（abort 联动：
//       外接任务状态机收到中断后补发 session.cancel，终态 aborted，协议实测 5.3；
//      内置 bundled 直接 close SDK runtime（官方放弃语义））
//       → 任务记录标记 cancelling（终态落地时被 aborted/error 覆盖）→ 返回取消结果。
//       → 会话路由摘除（取消即废弃：该会话不再作为同工程的延续目标）。
// 幂等：无运行任务 / 目标不存在均返回「无需取消」，不报错。

import { SessionRoutes } from '../lib/session-routes.js';

/** 会话路由表：与 dsh-run 共用同一进程内单例（globalThis.__dshBridge.sessionRoutes），
 *  取消后摘除立即反映到 dsh_run 的路由查询（避免新建实例读旧快照导致复用已取消会话）。 */
function sharedSessionRoutes(s) {
  let routes = s?.sessionRoutes ?? null;
  if (!routes || routes.dataDir !== s?.dataDir) {
    routes = new SessionRoutes(s?.dataDir);
    routes.load();
    if (s) s.sessionRoutes = routes;
  }
  return routes;
}

export const name = 'dsh_cancel';

export const description =
  '取消运行中的 dsh 任务（止损）：不传 id 时取消唯一运行中的任务；有多个任务在跑时须传 id 指定。' +
  '外接模式传 sessionId（内部中断会话，任务以 aborted 终态收尾）；内置 bundled 模式传 opId（关闭 SDK runtime 进程，任务以 aborted 终态收尾）。' +
  '幂等：无运行任务时返回「无需取消」。';

export const parameters = {
  type: 'object',
  properties: {
    sessionId: {
      type: 'string',
      description:
        '要取消任务的 id：外接模式用会话 id；内置 bundled 模式用 opId（dsh_run 返回 / dsh_status 任务记录里带）。' +
        '缺省取消唯一运行中的任务；有多个任务在跑时必须传',
    },
  },
  required: [],
};

export const sessionPermission = { kind: 'external_side_effect' };

/** 按入口键定位运行任务：先按 opKey（任务记录键），再按 sessionId（对齐 TaskRunner.cancelRequested 的查找语义） */
function findTarget(runner, sid) {
  const runs = runner._runs ?? new Map();
  if (sid) {
    return runs.get(sid) ?? [...runs.values()].find((c) => c.sessionId === sid) ?? null;
  }
  if (runs.size === 1) return [...runs.values()][0];
  return null;
}

async function cancel(ctx) {
  const s = globalThis.__dshBridge ?? {};
  const runner = s.runner;
  // 宿主把工具参数铺在 ctx 上（对齐 DSHana 实物）
  const sidRaw = ctx?.sessionId != null ? String(ctx.sessionId).trim() : '';
  const sid = sidRaw || null;

  // 无 runner → 无运行任务 → 幂等「无需取消」
  if (!runner || typeof runner.cancelRequested !== 'function') {
    return {
      content: [
        {
          type: 'text',
          text: '无需取消：没有运行中的 dsh 任务（尚未派单或任务已全部收尾）',
        },
      ],
      details: { dsh: { sessionId: sid, cancelled: false, runningCount: 0 } },
    };
  }

  const runs = runner._runs ?? new Map();
  if (runs.size === 0) {
    return {
      content: [
        { type: 'text', text: '无需取消：没有运行中的 dsh 任务（取消幂等）' },
      ],
      details: { dsh: { sessionId: sid, cancelled: false, runningCount: 0 } },
    };
  }
  if (!sid && runs.size > 1) {
    throw new Error(
      `有 ${runs.size} 个运行中的任务，请传 sessionId 指定要取消的任务（可用 dsh_status 查看）`
    );
  }

  const target = findTarget(runner, sid);
  if (!target) {
    // 目标不存在或已结束 → 幂等「无需取消」
    return {
      content: [
        {
          type: 'text',
          text: `无需取消：${sid} 对应的任务不存在或已结束（取消幂等）`,
        },
      ],
      details: { dsh: { sessionId: sid, cancelled: false, runningCount: runs.size } },
    };
  }

  const ok = runner.cancelRequested(target.opKey ?? target.sessionId ?? sid);
  const bundled = (s.connection?.effectiveMode ?? null) === 'bundled';

  // 会话路由摘除（取消即废弃：该会话不再作为同工程的延续目标；bundled 无会话概念跳过）
  const cancelledSid = target.sessionId ?? null;
  if (!bundled && cancelledSid) {
    try {
      const routes = sharedSessionRoutes(s);
      const removed = routes.removeBySessionId(cancelledSid);
      if (removed > 0) {
        try {
          ctx?.log?.info?.(`[dsh-bridge] 取消后已摘除 ${removed} 条会话路由（sessionId ${String(cancelledSid).slice(0, 12)}…）`);
        } catch {
          // 日志失败静默
        }
      }
    } catch {
      // 路由摘除失败静默（不影响取消本身）
    }
  }

  // 任务记录标记 cancelling（对齐实物 cancelledRequested 语义；终态落地时被 aborted/error 覆盖）
  try {
    const entry = s.ops?.get(target.opKey);
    if (entry && entry.status === 'running') entry.status = 'cancelling';
  } catch {
    // 任务记录更新失败静默（不影响取消本身）
  }

  const sessionIdOut = target.sessionId ?? sid;
  const short = sessionIdOut ? `${String(sessionIdOut).slice(0, 12)}…` : '（会话尚未建立）';
  const doneText = bundled
    ? `已请求取消任务 ${target.opKey ?? sid}：SDK runtime 进程已关闭，任务以 aborted 终态收尾`
    : `已请求取消任务 ${target.opKey ?? sid}（会话 ${short}）：dsh agent 将收到中断，任务以 aborted 终态收尾`;
  return {
    content: [
      {
        type: 'text',
        text: `${doneText}，宿主经后台消息带回结果`,
      },
    ],
    details: {
      dsh: {
        opId: target.opKey ?? null,
        sessionId: sessionIdOut ?? null,
        accepted: Boolean(ok),
        status: 'cancelling',
      },
    },
  };
}

/** 宿主调用约定：execute(input, ctx) 双参（0.446.6 实证）；合并兼容单参。
 *  防污染：宿主注入的当前会话 sessionId 不得污染工具的 sessionId 参数（0815 实测教训）。 */
export async function execute(input, ctx) {
  const params = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sessionCtx = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  const merged = { ...sessionCtx, ...params };
  delete merged.sessionId;
  if (params.sessionId != null && params.sessionId !== '') merged.sessionId = params.sessionId;
  try {
    return await cancel(merged);
  } catch (e) {
    try {
      merged?.log?.error?.('[dsh-bridge] dsh_cancel failed:', e?.stack || e?.message || String(e));
    } catch {
      // 日志失败静默
    }
    throw e;
  }
}

/** 清理单例连接（导出契约）：embedded 模式回收 dsh web host 子进程；与 index.js 注册的清理等价（幂等） */
export function closeProcess() {
  const s = globalThis.__dshBridge;
  const conn = s?.connection;
  if (conn && typeof conn.dispose === 'function') {
    return Promise.resolve(conn.dispose()).catch(() => {});
  }
}
