import { useState, type FormEvent } from 'react';
import type { TeamAdmin } from '../server/team/contracts.js';
import { ApiError, responseError } from './api';

export const teamUrl = '/api/v1/team';
export async function teamRequest<T>(path: string, body?: object, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'X-SpecMill-Request': '1' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET', headers, credentials: token ? 'omit' : 'same-origin',
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
  });
  if (!response.ok) throw await responseError(response, '请求失败，请核对登录身份和团队模式。');
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export const roles = { developer: '开发者', reviewer: '复核人', both: '开发与复核' };
export function TeamAdminPanel() {
  const [data, setData] = useState<TeamAdmin | null>(null);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endpoint = teamUrl + '/admin';
  const refresh = async () => setData(await teamRequest<TeamAdmin>(endpoint));
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (err) {
      if (err instanceof ApiError && [401, 403].includes(err.status ?? 0)) { setData(null); setIssued(null); }
      setError(err instanceof ApiError ? err.message : '操作结果未知，请刷新配置后核对。');
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, action: (form: FormData) => Promise<void>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void act(async () => { await action(values); form.reset(); await refresh(); });
  }
  return <section><h2>管理员配置</h2>
    {error && <p role="alert">{error}</p>}
    {data === null ? <>
      <button disabled={busy} onClick={() => void act(refresh)}>使用当前管理员会话</button>
      <form onSubmit={event => submit(event, async values => {
        await teamRequest('/api/v1/session', { token: values.get('token') });
      })}><label>管理员启动口令<input name="token" type="password" autoComplete="off" required /></label>
        <button disabled={busy}>管理员登录</button></form>
    </> : <>
      <form onSubmit={event => submit(event, async values => {
        setIssued(null);
        setIssued(await teamRequest(endpoint + '/members', { name: values.get('name') }));
      })}><label>成员名称<input name="name" maxLength={80} required /></label><button disabled={busy}>签发成员凭据</button></form>
      {issued && <div><p>请将此凭据交给 {issued.name}，离开页面后将无法再次查看。</p>
        <output aria-label="新签发的成员凭据">{issued.token}</output><button onClick={() => setIssued(null)}>隐藏凭据</button></div>}
      <form onSubmit={event => submit(event, async values => {
        await teamRequest(endpoint + '/projects', { name: values.get('name') });
      })}><label>团队项目名称<input name="name" maxLength={80} required /></label><button disabled={busy}>创建团队项目</button></form>
      <form onSubmit={event => submit(event, async values => {
        await teamRequest(endpoint + '/grants', { projectId: values.get('projectId'), memberId: values.get('memberId'), role: values.get('role') || null });
      })}>
        <label>授权项目<select name="projectId" required>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</select></label>
        <label>授权成员<select name="memberId" required>{data.members.map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}</select></label>
        <label>项目角色<select name="role">{Object.entries(roles).map(([key, name]) => <option key={key} value={key}>{name}</option>)}<option value="">撤销访问</option></select></label>
        <button disabled={busy || !data.members.length || !data.projects.length}>保存项目授权</button>
      </form>
      <h3>当前授权</h3>
      {data.grants.length ? <ul>{data.grants.map(g => <li key={g.projectId + g.memberId}>{data.projects.find(p => p.id === g.projectId)?.name} · {data.members.find(m => m.id === g.memberId)?.name} · {roles[g.role]}</li>)}</ul> : <p>尚无授权。</p>}
      <button disabled={busy} onClick={() => void act(refresh)}>刷新配置</button>
    </>}
  </section>;
}
