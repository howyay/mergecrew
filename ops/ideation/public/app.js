/**
 * Swipe deck for idea triage.
 *
 * Left = reject, right = accept, U = undo the last decision.
 * Every card shows the rubric numbers that produced its score, so a decision is
 * made against evidence and not against a headline. Accepting posts to the
 * server, which writes the execution task file and reports — truthfully —
 * whether an agent was actually spawned.
 */
const RUBRIC = { impact: 40, confidence: 20, effort: 20, risk: 20 };
const AXIS_LABEL = { impact: '影响', confidence: '置信', effort: '成本收益', risk: '安全性' };
const BAND_LABEL = { must: 'must', should: 'should', could: 'could', wont: 'wont' };
const THRESHOLD = 110;

const state = { pending: [], accepted: [], rejected: [], lastDecision: null, busy: false };

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

function toast(message, isError = false) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast show${isError ? ' err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = 'toast';
  }, 3600);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function card(idea, { top }) {
  const axes = el(
    'div',
    { class: 'axes' },
    Object.keys(RUBRIC).map((axis) => {
      const value = idea.features?.[axis] ?? 0;
      return el('div', { class: 'axis' }, [
        el('span', { text: AXIS_LABEL[axis] }),
        el('span', { class: 'bar' }, [el('i', { style: `width:${Math.round((value / RUBRIC[axis]) * 100)}%` })]),
        el('span', { class: 'axis-value', text: `${value}/${RUBRIC[axis]}` }),
      ]);
    }),
  );

  const node = el('article', { class: `card ${top ? 'top' : 'behind'} band-${idea.band}`, 'data-id': idea.id }, [
    el('div', { class: 'card-head' }, [
      el('h3', { text: idea.title }),
      el('div', { class: 'score' }, [el('b', { text: String(idea.score) }), el('span', { text: BAND_LABEL[idea.band] ?? idea.band })]),
    ]),
    el('div', { class: 'tags' }, [
      el('span', { class: 'tag', text: `来源 ${idea.source}` }),
      el('span', { class: 'tag', text: `成本 ${idea.effortHint}` }),
      el('span', { class: 'tag', text: `id ${idea.id}` }),
      ...(idea.stale ? [el('span', { class: 'tag stale', text: '当前信号已不再支持' })] : []),
    ]),
    el('p', { class: 'rationale', text: idea.rationale }),
    axes,
    el('ul', { class: 'evidence' }, (idea.evidence ?? []).map((e) => el('li', { text: e }))),
  ]);

  if (top) {
    node.append(
      el('div', { class: 'stamp accept', text: '接受' }),
      el('div', { class: 'stamp reject', text: '拒绝' }),
    );
    attachDrag(node);
  }
  return node;
}

function attachDrag(node) {
  const acceptStamp = node.querySelector('.stamp.accept');
  const rejectStamp = node.querySelector('.stamp.reject');
  let startX = 0;
  let dx = 0;
  let dragging = false;

  const paint = () => {
    node.style.transform = `translateX(${dx}px) rotate(${dx / 26}deg)`;
    acceptStamp.style.opacity = String(Math.max(0, dx / THRESHOLD));
    rejectStamp.style.opacity = String(Math.max(0, -dx / THRESHOLD));
  };
  const reset = () => {
    dragging = false;
    dx = 0;
    node.style.transition = 'transform 0.2s ease';
    paint();
    setTimeout(() => {
      node.style.transition = '';
    }, 200);
  };

  node.addEventListener('pointerdown', (event) => {
    if (state.busy) return;
    dragging = true;
    startX = event.clientX;
    node.style.transition = '';
    node.setPointerCapture?.(event.pointerId);
  });
  node.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    dx = event.clientX - startX;
    paint();
  });
  node.addEventListener('pointerup', () => {
    if (!dragging) return;
    const final = dx;
    if (final > THRESHOLD) {
      node.style.transition = 'transform 0.18s ease';
      node.style.transform = 'translateX(140%) rotate(18deg)';
      dragging = false;
      decide('accepted');
    } else if (final < -THRESHOLD) {
      node.style.transition = 'transform 0.18s ease';
      node.style.transform = 'translateX(-140%) rotate(-18deg)';
      dragging = false;
      decide('rejected');
    } else {
      reset();
    }
  });
  node.addEventListener('pointercancel', reset);
}

function render() {
  const stack = document.getElementById('stack');
  stack.replaceChildren();
  const top = state.pending[0];
  document.getElementById('empty').style.display = top ? 'none' : 'block';
  for (const idea of state.pending.slice(0, 2).reverse()) {
    stack.append(card(idea, { top: idea.id === top?.id }));
  }

  document.getElementById('accept').disabled = !top || state.busy;
  document.getElementById('reject').disabled = !top || state.busy;
  document.getElementById('undo').disabled = !state.lastDecision || state.busy;

  const acceptedList = document.getElementById('accepted');
  acceptedList.replaceChildren(
    ...state.accepted.map((idea) => {
      const exec = idea.execution ?? {};
      const status = exec.status ?? 'none';
      return el('li', {}, [
        el('div', {}, [
          el('div', { class: 'title', text: `${idea.title}` }),
          el('div', { class: 'path', text: exec.taskFile ? `任务文件 ${exec.taskFile}` : '尚未写任务文件' }),
          exec.reason ? el('div', { class: 'path', text: `原因：${exec.reason}` }) : null,
        ]),
        el('span', { class: `exec exec-${status}`, text: execLabel(status) }),
      ]);
    }),
  );
  document.getElementById('accepted-count').textContent = String(state.accepted.length);

  const rejectedList = document.getElementById('rejected');
  rejectedList.replaceChildren(...state.rejected.map((idea) => el('li', {}, [el('span', { text: idea.title })])));
  document.getElementById('rejected-count').textContent = String(state.rejected.length);
}

function execLabel(status) {
  return (
    {
      none: '未派发',
      queued: '已入队（执行器关闭）',
      running: '执行中',
      done: '已完成',
      failed: '失败',
      blocked: '被阻塞',
    }[status] ?? status
  );
}

async function load() {
  const [ideaBody, stateBody] = await Promise.all([api('/api/ideas'), api('/api/state')]);
  const all = ideaBody.ideas;
  state.pending = all.filter((i) => i.status === 'pending');
  state.accepted = all.filter((i) => i.status === 'accepted');
  state.rejected = all.filter((i) => i.status === 'rejected');

  const ci = stateBody.ci;
  const ciPill = document.getElementById('ci-pill');
  ciPill.textContent = ci ? `CI ${ci.status}${ci.failed?.length ? ` · ${ci.failed.length} 项失败` : ''}` : 'CI 无记录';
  ciPill.className = `pill ${ci?.status === 'pass' ? 'pill-pass' : ci?.status === 'fail' ? 'pill-fail' : 'pill-idle'}`;

  const gen = stateBody.lastGeneration;
  const genPill = document.getElementById('gen-pill');
  genPill.textContent = gen
    ? `生成器 ${gen.generator} · 新增 ${gen.added}${gen.staleMarked ? ` · 失效 ${gen.staleMarked}` : ''}`
    : '生成器 —';
  genPill.className = `pill ${gen?.generator === 'llm' ? 'pill-pass' : 'pill-idle'}`;

  document.getElementById('executor-hint').textContent = stateBody.executorEnabled
    ? '执行器开启：接受即派生 sandcastle agent。'
    : '执行器关闭（EXECUTOR=off）：接受只写任务文件，不派生 agent。';
  render();
}

async function decide(decision) {
  const idea = state.pending[0];
  if (!idea || state.busy) return;
  state.busy = true;
  render();
  try {
    const body = await api('/api/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: idea.id, decision }),
    });
    state.lastDecision = { id: idea.id, previous: 'pending' };
    if (decision === 'accepted') {
      const exec = body.idea?.execution ?? {};
      toast(
        exec.status === 'running'
          ? `已接受并派生 agent（pid ${exec.pid ?? '?'}）`
          : `已接受：${execLabel(exec.status ?? 'none')}${exec.reason ? ` — ${exec.reason}` : ''}`,
        ['blocked', 'failed'].includes(exec.status),
      );
    } else {
      toast('已拒绝：该指纹不会再出现');
    }
    await load();
  } catch (err) {
    toast(`操作失败：${err.message}`, true);
  } finally {
    state.busy = false;
    render();
  }
}

async function undo() {
  if (!state.lastDecision || state.busy) return;
  state.busy = true;
  try {
    await api('/api/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: state.lastDecision.id, decision: 'pending' }),
    });
    state.lastDecision = null;
    toast('已撤销上一条决定');
    await load();
  } catch (err) {
    toast(`撤销失败：${err.message}`, true);
  } finally {
    state.busy = false;
    render();
  }
}

async function generate() {
  toast('正在收集信号并生成想法…');
  try {
    const body = await api('/api/generate', { method: 'POST' });
    toast(`生成器 ${body.generator}：新增 ${body.added} 条，跳过 ${body.skipped} 条${body.fallbackReason ? `（${body.fallbackReason}）` : ''}`);
    await load();
  } catch (err) {
    toast(`生成失败：${err.message}`, true);
  }
}

document.getElementById('accept').addEventListener('click', () => decide('accepted'));
document.getElementById('reject').addEventListener('click', () => decide('rejected'));
document.getElementById('undo').addEventListener('click', undo);
document.getElementById('generate').addEventListener('click', generate);
document.getElementById('refresh').addEventListener('click', () => load().catch((e) => toast(e.message, true)));

window.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT') return;
  if (event.key === 'ArrowRight') decide('accepted');
  else if (event.key === 'ArrowLeft') decide('rejected');
  else if (event.key === 'u' || event.key === 'U') undo();
  else if (event.key === 'g' || event.key === 'G') generate();
  else if (event.key === 'r' || event.key === 'R') load().catch(() => {});
});

load().catch((err) => toast(`加载失败：${err.message}`, true));
