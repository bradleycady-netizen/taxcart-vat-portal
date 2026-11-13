import { buildDeps } from '../src/http/buildDeps.ts';
import { listRegistrations } from '../src/http/handlers/data.ts';

export function GET(request: Request): Promise<Response> {
  return listRegistrations(request, buildDeps(process.env).deps);
}
