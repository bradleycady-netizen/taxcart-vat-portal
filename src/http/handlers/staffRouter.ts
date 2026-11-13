import type { Deps } from '../types.ts';
import { errorResponse } from '../util.ts';
import { addUser, createClient, listClients, listUsers, removeUser, setLogo, syncNow, type StaffDeps } from './staff.ts';

/**
 * ALL staff endpoints live behind ONE serverless function, chosen by `?op=`. (The free Vercel plan allows at most
 * 12 functions per deployment, and every separate address would use one up.) Each handler still does its own
 * staff check, origin check and rate limit; this file only picks which one runs.
 *
 *   GET  /api/staff?op=clients            GET  /api/staff?op=users&tenant=<id>
 *   POST /api/staff?op=create-client      POST /api/staff?op=sync
 *   POST /api/staff?op=add-user           POST /api/staff?op=remove-user       POST /api/staff?op=logo
 */
export function staffRoute(request: Request, deps: Deps, staff: StaffDeps): Promise<Response> {
  const op = new URL(request.url).searchParams.get('op') ?? '';
  if (request.method === 'GET') {
    if (op === 'clients') return listClients(request, deps);
    if (op === 'users') return listUsers(request, deps);
  } else if (request.method === 'POST') {
    if (op === 'create-client') return createClient(request, deps, staff);
    if (op === 'sync') return syncNow(request, deps, staff);
    if (op === 'add-user') return addUser(request, deps);
    if (op === 'remove-user') return removeUser(request, deps);
    if (op === 'logo') return setLogo(request, deps);
  }
  return Promise.resolve(errorResponse(404, 'not_found', 'Not found.'));
}
