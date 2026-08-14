// dsh-approve.js —— 审批应答工具（dsh_approve）
// 协议细节以 DSH 官方实现与实测行为为准（DSH 0.1.0-rc.6）。
// 校验链：approvalId 必填 → 单例 runner 存在（否则报「无运行中的 dsh 任务」）
//   → respondApproval 内已含完整校验（对齐
//     审批存在 → 状态必须 pending（已应答/已解决拒答）→ POST /api/respond 被接受（accepted:true）
//   → 应答成功本地置 answered。三类错误（不存在/已应答/应答未接受）信息已是人话，直接抛出。
// 内置 headless 模式：无审批可答（越界 fail closed），返回说明性文本，不报错（SPEC-v0.2 T5）。
// 返回结构对齐。

import { HeadlessRunner } from '../lib/headless.js';

export const name = 'dsh_approve';

export const description =
  '应答 dsh 任务挂起的权限审批（仅外接模式）：dsh agent 请求越界权限时任务挂起，插件经 deferred 通道发审批通知' +
  '（带 approvalId/toolName/理由/参数原文）。allowed-once（默认）= 放行本次请求，agent 继续执行；' +
  'rejected = 拒绝本次请求。无人应答超时自动拒绝（approvalTimeoutMs，0=禁用）；审批也可在 dsh Web UI 人工处理。' +
  '内置 headless 模式无挂起审批（越界操作立即 fail closed），调用本工具会得到说明性提示。';

export const parameters = {
  type: 'object',
  properties: {
    approvalId: {
      type: 'string',
      description: '审批 id（审批通知里带）',
    },
    outcome: {
      type: 'string',
      enum: ['allowed-once', 'rejected'],
      description: 'allowed-once（默认）= 放行本次请求；rejected = 拒绝本次请求',
    },
    toolName: {
      type: 'string',
      description: '展示用：DSH 请求越界的工具名（审批通知里带，弹窗展示用）',
    },
    reason: {
      type: 'string',
      description: '展示用：DSH 请求越界的理由（审批通知里带，弹窗展示用）',
    },
    args: {
      type: 'string',
      description: '展示用：DSH 要执行的命令/参数原文（审批通知里带，弹窗展示用，授权决策依据）',
    },
    taskPreview: {
      type: 'string',
      description: '展示用：所属任务预览（审批通知里带，弹窗展示用）',
    },
  },
  required: ['approvalId'],
};

export const sessionPermission = { kind: 'external_side_effect' };

async function approve(ctx) {
  const s = globalThis.__dshBridge ?? {};
  const runner = s.runner;

  // 内置 headless：无审批可答（越界 fail closed），返回说明性文本，不报错（SPEC-v0.2 T5）
  if (runner instanceof HeadlessRunner) {
    return {
      content: [
        {
          type: 'text',
          text:
            '内置 headless 模式无挂起审批：越界操作会被沙箱立即拒绝（fail closed），agent 会在任务报告里说明。' +
            '无需应答任何审批；若您允许该越界操作，可带授权重派任务（dsh_run 传 permission=danger-full-access）。',
        },
      ],
      details: { dsh: { mode: 'embedded', pendingApprovals: 0 } },
    };
  }

  if (!runner || typeof runner.respondApproval !== 'function') {
    throw new Error('无运行中的 dsh 任务：尚未派单或任务已全部收尾（先调 dsh_run 派一单）');
  }
  // 宿主把工具参数铺在 ctx 上（对齐 DSHana 
  const approvalId = String(ctx?.approvalId ?? '').trim();
  if (!approvalId) throw new Error('approvalId 必填（审批通知里带）');
  const outcome = ctx?.outcome === 'rejected' ? 'rejected' : 'allowed-once';

  // 装饰信息（toolName/reason）在应答前取；respondApproval 内含完整校验链，错误信息已是人话
  const entry =
    (runner.pendingApprovals ?? []).find((p) => p.approvalId === approvalId) ?? null;
  const accepted = await runner.respondApproval(approvalId, outcome);

  const toolName = entry?.toolName ?? 'tool';
  const verb = outcome === 'allowed-once' ? '已放行' : '已拒绝';
  const reasonText = entry?.reason ? `（理由：${String(entry.reason).slice(0, 300)}）` : '';
  return {
    content: [{ type: 'text', text: `${verb}审批 ${approvalId} [${toolName}]${reasonText}` }],
    details: { dsh: { approvalId, toolName, outcome, accepted: Boolean(accepted) } },
  };
}

/** 宿主调用约定：execute(input, ctx) 双参（0.446.6 实证）；合并兼容单参。 */
export async function execute(input, ctx) {
  const params = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sessionCtx = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  const merged = { ...sessionCtx, ...params };
  try {
    return await approve(merged);
  } catch (e) {
    try {
      merged?.log?.error?.('[dsh-bridge] dsh_approve failed:', e?.stack || e?.message || String(e));
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
