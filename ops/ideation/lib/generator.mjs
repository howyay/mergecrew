/**
 * Idea generation.
 *
 * Two modes, both honest about which one ran:
 *   heuristic (default) — deterministic rules over repo signals. No network,
 *                          no credentials, always available.
 *   llm                 — an OpenAI-compatible chat completion asked for JSON
 *                          ideas grounded in the same signals. Requires
 *                          IDEA_LLM_BASE_URL + IDEA_LLM_API_KEY + IDEA_LLM_MODEL.
 *                          Any failure falls back to heuristic and records it.
 *
 * The generator never invents evidence: every idea carries the signal lines
 * that produced it, and `source` names the rule that fired.
 */
import { createHash } from 'node:crypto';
import { scoreFromIdea, scoreIdea } from './scorer.mjs';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Minimum number of commit subjects before the fix-churn ratio is treated as a
 * signal. Below this the denominator is too small to mean anything.
 */
export const MIN_CHURN_SAMPLE = 10;

export function ideaId(source, title) {
  const h = createHash('sha1').update(`${source}:${title}`).digest('hex').slice(0, 8);
  return `idea-${h}`;
}

function build({ source, title, rationale, evidence, effortHint, features }) {
  const base = { source, title, rationale, evidence, effortHint };
  const scored = features ? scoreIdea(features) : scoreFromIdea(base);
  return {
    id: ideaId(source, title),
    fingerprint: `${source}:${slug(title)}`,
    ...base,
    features: scored.features,
    score: scored.score,
    band: scored.band,
    scoreReasons: scored.reasons,
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    execution: null,
  };
}

/**
 * Deterministic rules. Order matters: earlier rules describe more urgent work,
 * so when the caller caps the result the urgent ones survive.
 */
export function heuristicIdeas(signals, { limit = 12 } = {}) {
  const out = [];

  const ci = signals.ci;
  if (ci && ci.status === 'fail') {
    out.push(
      build({
        source: 'ci-failure',
        title: `修复失败的 CI 检查：${ci.failedChecks[0] ?? '未知检查'}`,
        rationale: `最近一次 primitive CI 在 ${ci.head?.slice(0, 8) ?? '?'} 上失败，失败项为 ${ci.failedChecks.join(', ') || '未知'}。绿的主干是所有后续自动化的前提。`,
        evidence: [`ops/ci/state/last-run.json status=${ci.status}`, `head=${ci.head}`, `failed=${ci.failedChecks.join(',')}`],
        effortHint: 'small',
      }),
    );
  }
  if (!ci) {
    out.push(
      build({
        source: 'ci-missing',
        title: '让 primitive CI 产出第一份运行记录',
        rationale:
          'ops/ci/state/last-run.json 尚不存在——CI 循环还没在真实提交上跑过，任何"分支是绿的"判断此时都没有证据。',
        evidence: ['ops/ci/state/last-run.json missing', 'ops/ci/checks.conf'],
        effortHint: 'small',
      }),
    );
  }

  for (const cluster of signals.todos.clusters.slice(0, 4)) {
    if (cluster.count < 3) continue;
    out.push(
      build({
        source: 'todo-cluster',
        title: `清理 ${cluster.dir} 的 ${cluster.count} 处 TODO/FIXME`,
        rationale: `${cluster.dir} 聚集了 ${cluster.count} 处待办标记，说明这块代码反复被绕开。逐条判定"做掉或删掉"能降低后续每次改动的认知成本。`,
        evidence: cluster.samples,
        effortHint: cluster.count > 15 ? 'large' : cluster.count > 7 ? 'medium' : 'small',
      }),
    );
  }

  const cfg = signals.ciConfig;
  if (cfg) {
    for (const check of cfg.disabledChecks.slice(0, 2)) {
      out.push(
        build({
          source: 'disabled-check',
          title: `启用被注释掉的 CI 检查：${check.command.slice(0, 70)}`,
          rationale: `ops/ci/checks.conf 第 ${check.line} 行把这条检查注释掉了——它是被刻意跳过的门禁，不是不存在的门禁。要么修好它并启用，要么删掉这行，别让它无声地失效。`,
          evidence: [`ops/ci/checks.conf:${check.line} ${check.command}`],
          effortHint: 'small',
        }),
      );
    }
    if (cfg.deployExample && !cfg.deployHook) {
      out.push(
        build({
          source: 'deploy-hook',
          title: '接通 CD 钩子（deploy.sh 尚未启用）',
          rationale:
            'ops/ci/deploy.sh.example 存在但 ops/ci/deploy.sh 不存在，所以当前流水线只有 CI：检查全绿后什么也不会发生。补上部署脚本才算闭环。',
          evidence: ['ops/ci/deploy.sh.example exists', 'ops/ci/deploy.sh missing'],
          effortHint: 'medium',
        }),
      );
    }
  }

  for (const area of (signals.untestedAreas ?? []).slice(0, 3)) {
    out.push(
      build({
        source: 'untested-area',
        title: `为 ${area.dir} 补自动化测试`,
        rationale: `${area.dir} 下有 ${area.sourceCount} 个源码文件但没有任何 *.test.* 或 test/ 目录，改动它只能靠人工验证。`,
        evidence: area.sourceFiles,
        effortHint: area.sourceCount > 1 ? 'medium' : 'small',
      }),
    );
  }

  if (signals.backlog && signals.backlog.open > 0) {
    for (const item of signals.backlog.samples.slice(0, 3)) {
      out.push(
        build({
          source: 'backlog',
          title: `推进 backlog：${item}`,
          rationale: `${signals.backlog.file} 中仍有 ${signals.backlog.open} 项未勾选；这一条在列表最前，说明排期时被判断为优先。`,
          evidence: [`${signals.backlog.file} open=${signals.backlog.open}`, item],
          effortHint: 'medium',
        }),
      );
    }
  }

  // A ratio needs a sample. On a shallow clone (or a fresh repo) `git log` can
  // return a single subject, and one fix commit then reads as 100% churn.
  if (signals.commitCount >= MIN_CHURN_SAMPLE && signals.fixishRatio >= 0.25 && signals.fixishCommits.length) {
    out.push(
      build({
        source: 'fix-churn',
        title: '为最近反复修复的模块补回归测试',
        rationale: `最近 ${signals.commitCount} 条提交中有 ${Math.round(signals.fixishRatio * 100)}% 是修复类提交，反复修同一块通常意味着缺少能锁住行为的测试。`,
        evidence: signals.fixishCommits.map((s) => `commit: ${s}`),
        effortHint: 'medium',
      }),
    );
  }

  return out.slice(0, limit);
}

const LLM_SYSTEM = `You propose engineering ideas for a software repository.
You receive a JSON signal bundle (git history, TODO clusters, open backlog items, last CI result).
Rules:
- Propose 3 to 6 ideas. Every idea MUST cite at least one concrete string from the signals as evidence.
- Do not propose anything the signals do not support. No invented file paths, no invented features.
- Prefer small, verifiable changes over rewrites.
- Score each idea yourself on this rubric: impact 0-40, confidence 0-20, effort 0-20 (higher = cheaper), risk 0-20 (higher = safer).
- Reply with JSON only, no prose, no code fences, shaped exactly:
{"ideas":[{"title":"...","rationale":"...","evidence":["..."],"effortHint":"small|medium|large","features":{"impact":0,"confidence":0,"effort":0,"risk":0}}]}`;

/** Call an OpenAI-compatible /chat/completions endpoint. Throws on any problem. */
export async function llmIdeas(signals, { limit = 12, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const baseUrl = process.env.IDEA_LLM_BASE_URL;
  const apiKey = process.env.IDEA_LLM_API_KEY;
  const model = process.env.IDEA_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('IDEA_LLM_BASE_URL / IDEA_LLM_API_KEY / IDEA_LLM_MODEL not all set');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: LLM_SYSTEM },
          { role: 'user', content: JSON.stringify(signals) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`llm http ${res.status}`);
    payload = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const text = payload?.choices?.[0]?.message?.content ?? '';
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error('llm response contained no JSON object');
  const parsed = JSON.parse(match[0]);
  const ideas = Array.isArray(parsed?.ideas) ? parsed.ideas : [];
  if (!ideas.length) throw new Error('llm returned zero ideas');

  return ideas
    .filter((i) => i && typeof i.title === 'string' && i.title.trim())
    .slice(0, limit)
    .map((i) =>
      build({
        source: 'llm',
        title: i.title.trim().slice(0, 160),
        rationale: String(i.rationale ?? '').slice(0, 1000),
        evidence: Array.isArray(i.evidence) ? i.evidence.map((e) => String(e).slice(0, 200)).slice(0, 6) : [],
        effortHint: ['small', 'medium', 'large'].includes(i.effortHint) ? i.effortHint : 'medium',
        features: i.features,
      }),
    );
}

/**
 * Resolve the configured mode. Returns ideas plus a truthful record of which
 * generator produced them and why any fallback happened.
 */
export async function generateIdeas(signals, { mode = process.env.IDEA_GENERATOR ?? 'auto', limit = 12, fetchImpl } = {}) {
  const wantLlm = mode === 'llm' || (mode === 'auto' && process.env.IDEA_LLM_BASE_URL && process.env.IDEA_LLM_API_KEY);
  if (wantLlm) {
    try {
      const ideas = await llmIdeas(signals, { limit, fetchImpl });
      return { generator: 'llm', fallbackReason: null, ideas };
    } catch (err) {
      const ideas = heuristicIdeas(signals, { limit });
      return { generator: 'heuristic', fallbackReason: `llm failed: ${err?.message ?? err}`, ideas };
    }
  }
  return { generator: 'heuristic', fallbackReason: null, ideas: heuristicIdeas(signals, { limit }) };
}
