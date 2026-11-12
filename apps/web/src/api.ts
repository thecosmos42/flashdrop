import type { OrderView, Role } from '@dakar/contracts';

let csrf = '';
export type Session = { role: Role; csrf: string };

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && csrf ? { 'x-csrf': csrf, 'Idempotency-Key': crypto.randomUUID() } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message ?? 'Action failed');
  return result as T;
}

export async function me(): Promise<Session> {
  const session = await request<Session>('/me'); csrf = session.csrf; return session;
}
export async function login(role: Role, code: string): Promise<Session> {
  const session = await request<Session>('/sessions', 'POST', { role, code }); csrf = session.csrf; return session;
}
export async function logout(): Promise<void> { await request('/sessions/current', 'DELETE'); csrf = ''; }
export const orders = () => request<OrderView[]>('/orders');
export const createOrder = (body: {description:string; quantity:number; goodsSat:number; deliverySat:number}) => request<OrderView>('/orders','POST',body);
export const action = (id: string, name: string, body?: unknown) => request<OrderView>(`/orders/${id}/${name}`,'POST',body ?? {});
